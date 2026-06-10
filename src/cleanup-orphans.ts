import { existsSync } from 'node:fs'
import { copyFile, mkdir, rm } from 'node:fs/promises'
import path from 'node:path'

import { migrateControlPlaneApprovalsToRepoLocal } from './config-io.js'
import {
  type BelayConfigV3,
  configuredControlPlaneDir,
  defaultControlPlaneDir,
} from './core/config.js'

const APPROVAL_STATE_FILES = ['pending-approvals.json', 'approved-approvals.json'] as const

export interface CleanupOrphanResult {
  actions: string[]
}

function repoLocalApprovalDir(repoRoot: string): string {
  return path.join(repoRoot, '.cursor', 'belay')
}

function hasApprovalFiles(dir: string): boolean {
  return APPROVAL_STATE_FILES.some((fileName) => existsSync(path.join(dir, fileName)))
}

async function archiveApprovalFiles(sourceDir: string, archiveDir: string): Promise<void> {
  await mkdir(archiveDir, { recursive: true })
  for (const fileName of APPROVAL_STATE_FILES) {
    const sourcePath = path.join(sourceDir, fileName)
    if (existsSync(sourcePath)) {
      await copyFile(sourcePath, path.join(archiveDir, fileName))
      await rm(sourcePath, { force: true })
    }
  }
}

export async function cleanupOrphanApprovalState(
  repoRoot: string,
  config: BelayConfigV3,
  options: { dryRun?: boolean } = {},
): Promise<CleanupOrphanResult> {
  const actions: string[] = []
  const dryRun = options.dryRun === true
  const repoLocalDir = repoLocalApprovalDir(repoRoot)
  const stamp = new Date().toISOString().replaceAll(':', '-')

  if (config.controlPlane.enabled) {
    if (hasApprovalFiles(repoLocalDir)) {
      const archiveDir = path.join(repoLocalDir, 'archive', stamp)
      if (dryRun) {
        actions.push(`Would archive stale repo-local approval files to ${archiveDir}`)
      } else {
        await archiveApprovalFiles(repoLocalDir, archiveDir)
        actions.push(`Archived stale repo-local approval files to ${archiveDir}`)
      }
    }
    return { actions }
  }

  const controlPlaneDirs = new Set<string>([configuredControlPlaneDir(config)])
  if (!config.controlPlane.configDir) {
    controlPlaneDirs.add(defaultControlPlaneDir())
  }

  for (const controlPlaneDir of controlPlaneDirs) {
    if (!hasApprovalFiles(controlPlaneDir)) {
      continue
    }
    const archiveDir = path.join(repoLocalDir, 'archive', 'control-plane', stamp)
    if (dryRun) {
      actions.push(
        `Would migrate approvals from ${controlPlaneDir} to ${repoLocalDir} and archive control-plane copies at ${archiveDir}`,
      )
      continue
    }
    await migrateControlPlaneApprovalsToRepoLocal(repoRoot, config, controlPlaneDir)
    await archiveApprovalFiles(controlPlaneDir, archiveDir)
    actions.push(
      `Migrated approvals from ${controlPlaneDir} to ${repoLocalDir} and archived control-plane copies at ${archiveDir}`,
    )
  }

  return { actions }
}
