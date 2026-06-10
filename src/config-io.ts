import { existsSync } from 'node:fs'
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { compactApprovals, isExpired, mergeApprovalStates } from './core/approval.js'
import {
  approvedApprovalsFile,
  type BelayConfigV3,
  belayStateDir,
  mergeConfig,
  pendingApprovalsFile,
} from './core/config.js'
import type { ApprovalStateFile } from './core/types.js'
import { DEFAULT_CONFIG } from './defaults.js'

export function configPathFor(repoRoot: string): string {
  return path.join(repoRoot, '.cursor', 'belay.config.json')
}

export { belayStateDir }

export function pendingApprovalsPath(repoRoot: string, config: BelayConfigV3): string {
  return pendingApprovalsFile(config, repoRoot)
}

export function approvedApprovalsPath(repoRoot: string, config: BelayConfigV3): string {
  return approvedApprovalsFile(config, repoRoot)
}

export function runtimeCorePath(repoRoot: string): string {
  return path.join(repoRoot, '.cursor', 'belay', 'runtime', 'core.mjs')
}

export async function ensureBelayStateDir(
  config: BelayConfigV3,
  repoRoot: string,
): Promise<string> {
  const stateDir = belayStateDir(config, repoRoot)
  await mkdir(stateDir, { recursive: true })
  return stateDir
}

const APPROVAL_STATE_FILES = ['pending-approvals.json', 'approved-approvals.json'] as const

async function readApprovalStateFile(filePath: string): Promise<ApprovalStateFile> {
  const raw = await readFile(filePath, 'utf8')
  const parsed = JSON.parse(raw) as ApprovalStateFile
  return {
    version: 1,
    approvals: Array.isArray(parsed.approvals) ? parsed.approvals : [],
  }
}

async function writeApprovalStateFile(filePath: string, state: ApprovalStateFile): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true })
  await writeFile(filePath, `${JSON.stringify(compactApprovals(state), null, 2)}\n`, 'utf8')
}

export async function migrateRepoLocalApprovalsToControlPlane(
  repoRoot: string,
  config: BelayConfigV3,
): Promise<void> {
  if (!config.controlPlane.enabled) {
    return
  }
  const repoLocalDir = path.join(repoRoot, '.cursor', 'belay')
  const targetDir = belayStateDir(config, repoRoot)
  await mkdir(targetDir, { recursive: true })
  for (const fileName of APPROVAL_STATE_FILES) {
    const from = path.join(repoLocalDir, fileName)
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

export async function loadConfigFile(repoRoot: string): Promise<BelayConfigV3> {
  const configPath = configPathFor(repoRoot)
  if (!existsSync(configPath)) {
    return { ...DEFAULT_CONFIG }
  }
  const raw = await readFile(configPath, 'utf8')
  return mergeConfig(JSON.parse(raw))
}

export async function writeConfigFile(repoRoot: string, config: BelayConfigV3): Promise<void> {
  await writeFile(configPathFor(repoRoot), `${JSON.stringify(config, null, 2)}\n`, 'utf8')
}

export async function mergeAndWriteConfig(repoRoot: string): Promise<BelayConfigV3> {
  const configPath = configPathFor(repoRoot)
  let existing: unknown = {}
  if (existsSync(configPath)) {
    existing = JSON.parse(await readFile(configPath, 'utf8'))
  }
  const merged = mergeConfig(existing)
  await writeConfigFile(repoRoot, merged)
  await ensureBelayStateDir(merged, repoRoot)
  if (merged.controlPlane.enabled) {
    await migrateRepoLocalApprovalsToControlPlane(repoRoot, merged)
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
