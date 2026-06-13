import { existsSync } from 'node:fs'
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { type AdapterName, getAdapterLayout } from './adapters/layouts/index.js'
import { compactApprovals, isExpired, mergeApprovalStates } from './core/approval.js'
import {
  approvedApprovalsFile,
  type BelayConfigV3,
  belayStateDir,
  configuredControlPlaneDir,
  mergeConfig,
  pendingApprovalsFile,
} from './core/config.js'
import {
  type LayeredConfigResult,
  resolveLayeredConfig,
  teamConfigPath,
} from './core/config-layers.js'
import type { ApprovalStateFile } from './core/types.js'

export type { LayeredConfigResult }
export function resolveAdapterName(config: BelayConfigV3): AdapterName {
  if (config.adapter === 'claude') {
    return 'claude'
  }
  if (config.adapter === 'codex') {
    return 'codex'
  }
  return 'cursor'
}

export function detectAdapterName(repoRoot: string): AdapterName {
  if (existsSync(configPathFor(repoRoot, 'claude'))) {
    return 'claude'
  }
  if (existsSync(configPathFor(repoRoot, 'codex'))) {
    return 'codex'
  }
  return 'cursor'
}

export function configPathFor(repoRoot: string, adapter: AdapterName = 'cursor'): string {
  return getAdapterLayout(adapter).configPath(repoRoot)
}

export function repoLocalStateDirFor(repoRoot: string, config: BelayConfigV3): string {
  return getAdapterLayout(resolveAdapterName(config)).repoLocalStateDir(repoRoot)
}

export function runtimeCorePath(repoRoot: string, adapter: AdapterName = 'cursor'): string {
  const layout = getAdapterLayout(adapter)
  return path.join(layout.runtimeDir(repoRoot), 'core.mjs')
}

export function pendingApprovalsPath(repoRoot: string, config: BelayConfigV3): string {
  return pendingApprovalsFile(config, repoLocalStateDirFor(repoRoot, config))
}

export function approvedApprovalsPath(repoRoot: string, config: BelayConfigV3): string {
  return approvedApprovalsFile(config, repoLocalStateDirFor(repoRoot, config))
}

export { belayStateDir }

export async function ensureBelayStateDir(
  config: BelayConfigV3,
  repoRoot: string,
): Promise<string> {
  const stateDir = belayStateDir(config, repoLocalStateDirFor(repoRoot, config))
  await mkdir(stateDir, { recursive: true })
  return stateDir
}

const APPROVAL_STATE_FILES = ['pending-approvals.json', 'approved-approvals.json'] as const

function approvalFilesExist(dir: string): boolean {
  return APPROVAL_STATE_FILES.some((fileName) => existsSync(path.join(dir, fileName)))
}

async function repoLocalApprovalsEmpty(repoRoot: string, config: BelayConfigV3): Promise<boolean> {
  const repoLocalDir = repoLocalStateDirFor(repoRoot, config)
  if (!approvalFilesExist(repoLocalDir)) {
    return true
  }
  for (const fileName of APPROVAL_STATE_FILES) {
    const filePath = path.join(repoLocalDir, fileName)
    if (!existsSync(filePath)) {
      continue
    }
    const state = await readApprovalStateFile(filePath)
    if (state.approvals.length > 0) {
      return false
    }
  }
  return true
}

async function readApprovalStateFile(filePath: string): Promise<ApprovalStateFile> {
  const raw = await readFile(filePath, 'utf8')
  const parsed = JSON.parse(raw) as ApprovalStateFile
  return {
    version: parsed.version === 2 ? 2 : 1,
    approvals: Array.isArray(parsed.approvals) ? parsed.approvals : [],
  }
}

async function writeApprovalStateFile(filePath: string, state: ApprovalStateFile): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true })
  await writeFile(filePath, `${JSON.stringify(compactApprovals(state), null, 2)}\n`, 'utf8')
}

async function migrateApprovalFilesBetween(sourceDir: string, targetDir: string): Promise<void> {
  await mkdir(targetDir, { recursive: true })
  for (const fileName of APPROVAL_STATE_FILES) {
    const from = path.join(sourceDir, fileName)
    const to = path.join(targetDir, fileName)
    if (!existsSync(from)) {
      continue
    }
    if (!existsSync(to)) {
      await copyFile(from, to)
      continue
    }
    const targetState = await readApprovalStateFile(to)
    const sourceState = await readApprovalStateFile(from)
    await writeApprovalStateFile(to, mergeApprovalStates(targetState, sourceState))
  }
}

export async function migrateRepoLocalApprovalsToControlPlane(
  repoRoot: string,
  config: BelayConfigV3,
): Promise<void> {
  if (!config.controlPlane.enabled) {
    return
  }
  const repoLocalDir = repoLocalStateDirFor(repoRoot, config)
  const targetDir = belayStateDir(config, repoLocalDir)
  await migrateApprovalFilesBetween(repoLocalDir, targetDir)
}

export async function migrateControlPlaneApprovalsToRepoLocal(
  repoRoot: string,
  config: BelayConfigV3,
  sourceDir: string = configuredControlPlaneDir(config),
): Promise<void> {
  if (config.controlPlane.enabled) {
    return
  }
  const targetDir = repoLocalStateDirFor(repoRoot, config)
  await migrateApprovalFilesBetween(sourceDir, targetDir)
}

export async function loadLayeredConfig(
  repoRoot: string,
  adapter: AdapterName = detectAdapterName(repoRoot),
): Promise<LayeredConfigResult> {
  const layout = getAdapterLayout(adapter)
  const configPath = configPathFor(repoRoot, adapter)
  let repoConfig: unknown = {}
  if (existsSync(configPath)) {
    repoConfig = JSON.parse(await readFile(configPath, 'utf8'))
  }

  let teamConfig: Record<string, unknown> | null = null
  const teamPath = teamConfigPath()
  if (existsSync(teamPath)) {
    teamConfig = JSON.parse(await readFile(teamPath, 'utf8')) as Record<string, unknown>
  }

  return resolveLayeredConfig({
    repoConfig,
    adapterDefaults: layout.defaultConfig(repoRoot) as BelayConfigV3,
    teamConfig,
    teamConfigPath: teamPath,
    repoConfigPath: existsSync(configPath) ? configPath : undefined,
  })
}

export async function loadConfigFile(
  repoRoot: string,
  adapter: AdapterName = detectAdapterName(repoRoot),
): Promise<BelayConfigV3> {
  const layered = await loadLayeredConfig(repoRoot, adapter)
  return layered.config
}

export async function writeConfigFile(
  repoRoot: string,
  config: BelayConfigV3,
  adapter: AdapterName = resolveAdapterName(config),
): Promise<void> {
  const configPath = configPathFor(repoRoot, adapter)
  await mkdir(path.dirname(configPath), { recursive: true })
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8')
}

export async function mergeAndWriteConfig(
  repoRoot: string,
  adapter: AdapterName = 'cursor',
): Promise<BelayConfigV3> {
  const layout = getAdapterLayout(adapter)
  const configPath = layout.configPath(repoRoot)
  let existing: unknown = {}
  if (existsSync(configPath)) {
    existing = JSON.parse(await readFile(configPath, 'utf8'))
  }
  const merged = mergeConfig(existing, layout.defaultConfig(repoRoot) as BelayConfigV3)
  await writeConfigFile(repoRoot, merged, adapter)
  await ensureBelayStateDir(merged, repoRoot)
  if (merged.controlPlane.enabled) {
    await migrateRepoLocalApprovalsToControlPlane(repoRoot, merged)
  } else {
    const sourceDir = configuredControlPlaneDir(merged)
    if (approvalFilesExist(sourceDir) && (await repoLocalApprovalsEmpty(repoRoot, merged))) {
      await migrateControlPlaneApprovalsToRepoLocal(repoRoot, merged, sourceDir)
    }
  }
  return merged
}

export async function loadApprovalState(
  repoRoot: string,
  fileName: 'pending-approvals.json' | 'approved-approvals.json',
  config: BelayConfigV3,
): Promise<ApprovalStateFile> {
  const filePath =
    fileName === 'pending-approvals.json'
      ? pendingApprovalsPath(repoRoot, config)
      : approvedApprovalsPath(repoRoot, config)
  if (!existsSync(filePath)) {
    return { version: 1, approvals: [] }
  }
  return readApprovalStateFile(filePath)
}

export async function saveApprovalState(
  repoRoot: string,
  fileName: 'pending-approvals.json' | 'approved-approvals.json',
  state: ApprovalStateFile,
  config: BelayConfigV3,
): Promise<void> {
  const filePath =
    fileName === 'pending-approvals.json'
      ? pendingApprovalsPath(repoRoot, config)
      : approvedApprovalsPath(repoRoot, config)
  await writeApprovalStateFile(filePath, state)
}

export function countExpiredPending(state: ApprovalStateFile): number {
  return state.approvals.filter((approval) => isExpired(approval)).length
}
