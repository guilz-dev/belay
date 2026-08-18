import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { chmod, mkdir, open, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { type AdapterName, getAdapterLayout } from './adapters/layouts/index.js'
import { compactApprovals, isExpired, mergeApprovalStates } from './core/approval.js'
import { mutateApprovalStateWithRetry } from './core/capability/approval-state-mutation.js'
import {
  approvedApprovalsFile,
  type BelayConfigV3,
  belayStateDir,
  configuredControlPlaneDir,
  mergeConfig,
  pendingApprovalsFile,
  stripForbiddenShellOverrideLists,
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
  await mkdir(stateDir, { recursive: true, mode: 0o700 })
  return stateDir
}

const APPROVAL_STATE_FILES = ['pending-approvals.json', 'approved-approvals.json'] as const

function approvalFilesExist(dir: string): boolean {
  return APPROVAL_STATE_FILES.some((fileName) => existsSync(path.join(dir, fileName)))
}

async function isCorruptApprovalStateFile(filePath: string): Promise<boolean> {
  const raw = await readFile(filePath, 'utf8')
  try {
    JSON.parse(raw)
    return false
  } catch (error) {
    return error instanceof SyntaxError
  }
}

function normalizeApprovalStateFile(parsed: ApprovalStateFile): ApprovalStateFile {
  const version = parsed.version === 3 ? 3 : parsed.version === 2 ? 2 : 1
  return {
    version,
    revision: typeof parsed.revision === 'number' ? parsed.revision : undefined,
    approvals: Array.isArray(parsed.approvals) ? parsed.approvals : [],
  }
}

/** Gate reads: corrupt JSON is treated as empty state (fail-closed). */
async function readApprovalStateFileForGate(filePath: string): Promise<ApprovalStateFile> {
  const raw = await readFile(filePath, 'utf8')
  try {
    return normalizeApprovalStateFile(JSON.parse(raw) as ApprovalStateFile)
  } catch (error) {
    if (error instanceof SyntaxError) {
      return { version: 1, approvals: [] }
    }
    throw error
  }
}

/** Migration reads: corrupt JSON must not be treated as empty. */
async function readApprovalStateFileStrict(filePath: string): Promise<ApprovalStateFile> {
  const raw = await readFile(filePath, 'utf8')
  return normalizeApprovalStateFile(JSON.parse(raw) as ApprovalStateFile)
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
    if (await isCorruptApprovalStateFile(filePath)) {
      return false
    }
    const state = await readApprovalStateFileForGate(filePath)
    if (state.approvals.length > 0) {
      return false
    }
  }
  return true
}

async function writeApprovalStateFile(filePath: string, state: ApprovalStateFile): Promise<void> {
  const directory = path.dirname(filePath)
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const tempPath = path.join(
    directory,
    `.${path.basename(filePath)}.${process.pid}.${randomUUID()}.tmp`,
  )
  let handle: Awaited<ReturnType<typeof open>> | null = null
  try {
    handle = await open(tempPath, 'wx', 0o600)
    await handle.writeFile(`${JSON.stringify(compactApprovals(state), null, 2)}\n`, 'utf8')
    await handle.sync()
    await handle.close()
    handle = null
    await rename(tempPath, filePath)
    await chmod(filePath, 0o600)

    const directoryHandle = await open(directory, 'r')
    try {
      await directoryHandle.sync().catch(() => undefined)
    } finally {
      await directoryHandle.close()
    }
  } finally {
    if (handle) {
      await handle.close().catch(() => undefined)
    }
    await unlink(tempPath).catch(() => undefined)
  }
}

async function migrateApprovalFilesBetween(sourceDir: string, targetDir: string): Promise<void> {
  await mkdir(targetDir, { recursive: true, mode: 0o700 })
  for (const fileName of APPROVAL_STATE_FILES) {
    const from = path.join(sourceDir, fileName)
    const to = path.join(targetDir, fileName)
    if (!existsSync(from)) {
      continue
    }
    if (
      (await isCorruptApprovalStateFile(from)) ||
      (existsSync(to) && (await isCorruptApprovalStateFile(to)))
    ) {
      continue
    }
    const sourceState = await readApprovalStateFileStrict(from)
    const migrated = await mutateApprovalStateWithRetry({
      load: async () => ({
        filePath: to,
        state: existsSync(to)
          ? await readApprovalStateFileStrict(to)
          : { version: 1, approvals: [] },
      }),
      write: writeApprovalStateFile,
      mutate: (targetState) => ({
        state:
          targetState.approvals.length === 0
            ? sourceState
            : mergeApprovalStates(targetState, sourceState),
        result: true,
      }),
    })
    if (migrated !== true) {
      throw new Error(`Failed to migrate approval state to ${to}`)
    }
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
  await writeFile(
    configPath,
    `${JSON.stringify(stripForbiddenShellOverrideLists(config), null, 2)}\n`,
    'utf8',
  )
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
  return readApprovalStateFileForGate(filePath)
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
