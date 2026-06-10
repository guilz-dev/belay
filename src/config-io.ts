import { existsSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { compactApprovals, isExpired } from './core/approval.js'
import { type BelayConfigV2, mergeConfig } from './core/config.js'
import type { ApprovalStateFile } from './core/types.js'
import { DEFAULT_CONFIG } from './defaults.js'

export function configPathFor(repoRoot: string): string {
  return path.join(repoRoot, '.cursor', 'belay.config.json')
}

export function pendingApprovalsPath(repoRoot: string): string {
  return path.join(repoRoot, '.cursor', 'belay', 'pending-approvals.json')
}

export function approvedApprovalsPath(repoRoot: string): string {
  return path.join(repoRoot, '.cursor', 'belay', 'approved-approvals.json')
}

export function runtimeCorePath(repoRoot: string): string {
  return path.join(repoRoot, '.cursor', 'belay', 'runtime', 'core.mjs')
}

export async function loadConfigFile(repoRoot: string): Promise<BelayConfigV2> {
  const configPath = configPathFor(repoRoot)
  if (!existsSync(configPath)) {
    return { ...DEFAULT_CONFIG }
  }
  const raw = await readFile(configPath, 'utf8')
  return mergeConfig(JSON.parse(raw))
}

export async function writeConfigFile(repoRoot: string, config: BelayConfigV2): Promise<void> {
  await writeFile(configPathFor(repoRoot), `${JSON.stringify(config, null, 2)}\n`, 'utf8')
}

export async function mergeAndWriteConfig(repoRoot: string): Promise<BelayConfigV2> {
  const configPath = configPathFor(repoRoot)
  let existing: unknown = {}
  if (existsSync(configPath)) {
    existing = JSON.parse(await readFile(configPath, 'utf8'))
  }
  const merged = mergeConfig(existing)
  await writeConfigFile(repoRoot, merged)
  return merged
}

export async function loadApprovalState(
  repoRoot: string,
  fileName: 'pending-approvals.json' | 'approved-approvals.json',
): Promise<ApprovalStateFile> {
  const filePath =
    fileName === 'pending-approvals.json'
      ? pendingApprovalsPath(repoRoot)
      : approvedApprovalsPath(repoRoot)
  if (!existsSync(filePath)) {
    return { version: 1, approvals: [] }
  }
  const raw = await readFile(filePath, 'utf8')
  const parsed = JSON.parse(raw) as ApprovalStateFile
  return {
    version: 1,
    approvals: Array.isArray(parsed.approvals) ? parsed.approvals : [],
  }
}

export async function saveApprovalState(
  repoRoot: string,
  fileName: 'pending-approvals.json' | 'approved-approvals.json',
  state: ApprovalStateFile,
): Promise<void> {
  const filePath =
    fileName === 'pending-approvals.json'
      ? pendingApprovalsPath(repoRoot)
      : approvedApprovalsPath(repoRoot)
  await writeFile(filePath, `${JSON.stringify(compactApprovals(state), null, 2)}\n`, 'utf8')
}

export function countExpiredPending(state: ApprovalStateFile): number {
  return state.approvals.filter((approval) => isExpired(approval)).length
}
