import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { canonicalStringify, hashValue } from '../fingerprint.js'
import { canonicalPath } from '../path-utils.js'
import {
  artifactRepoRoot,
  RECOVERY_CHECKPOINT_CORRUPT,
  readRecoveryArtifact,
  writeRecoveryState,
} from './artifact-store.js'
import { matchRecoverySide } from './reconcile.js'
import { assertRecoveryResourceIdentity } from './resource-identity.js'
import {
  applyRecoverySnapshot,
  assertRecoverySafeTarget,
  captureRecoverySnapshot,
  recoverySnapshotHash,
  recoveryStateHash,
  sortRecoveryEntriesForSide,
  withoutRecoveryBlob,
} from './snapshot-node.js'
import type { RecoveryFileSnapshotV2 } from './types.js'

export const RECOVERY_RESTORE_CONFLICT = 'recovery_restore_conflict'
export const RECOVERY_RESTORE_REASON = 'recovery_restore'

async function assertExpectedRepoRoot(
  stateDir: string,
  checkpointId: string,
  expectedRepoRoot?: string,
): Promise<void> {
  if (
    expectedRepoRoot &&
    (await artifactRepoRoot(stateDir, checkpointId)) !== canonicalPath(expectedRepoRoot)
  ) {
    throw new Error('recovery_checkpoint_repo_mismatch')
  }
}

export async function recoveryRestoreBinding(
  stateDir: string,
  checkpointId: string,
  expectedRepoRoot?: string,
): Promise<{
  fingerprint: string
  manifestHash: string
  postStateHash: string
  paths: string[]
  repoRoot: string
}> {
  await assertExpectedRepoRoot(stateDir, checkpointId, expectedRepoRoot)
  const loaded = await readRecoveryArtifact(stateDir, checkpointId)
  await assertRecoveryResourceIdentity(loaded.manifest)
  if (Date.parse(loaded.manifest.expiresAt) <= Date.now()) {
    throw new Error('recovery_checkpoint_expired')
  }
  if (!['applied', 'conflict'].includes(loaded.state.state)) {
    throw new Error(`recovery_checkpoint_not_applied:${loaded.state.state}`)
  }
  if (!(await matchRecoverySide(loaded.manifest.repoRoot, loaded.manifest.entries, 'after'))) {
    await writeRecoveryState(
      loaded.artifactDir,
      'conflict',
      loaded.manifestHash,
      RECOVERY_RESTORE_CONFLICT,
    )
    throw new Error(RECOVERY_RESTORE_CONFLICT)
  }
  const paths = loaded.manifest.entries.map((entry) => entry.path).sort()
  const postStateHash = recoveryStateHash(loaded.manifest.entries, 'after')
  return {
    fingerprint: hashValue(
      canonicalStringify({
        action: 'recovery.restore',
        repoRoot: loaded.manifest.repoRoot,
        checkpointId,
        manifestHash: loaded.manifestHash,
        postStateHash,
        paths,
      }),
    ),
    manifestHash: loaded.manifestHash,
    postStateHash,
    paths,
    repoRoot: loaded.manifest.repoRoot,
  }
}

export async function restoreRecoveryCheckpoint(
  stateDir: string,
  checkpointId: string,
  expectedRepoRoot?: string,
): Promise<{ manifestHash: string; changeCount: number }> {
  await assertExpectedRepoRoot(stateDir, checkpointId, expectedRepoRoot)
  const loaded = await readRecoveryArtifact(stateDir, checkpointId)
  await assertRecoveryResourceIdentity(loaded.manifest)
  if (Date.parse(loaded.manifest.expiresAt) <= Date.now()) {
    throw new Error('recovery_checkpoint_expired')
  }
  if (!['applied', 'conflict'].includes(loaded.state.state)) {
    throw new Error(`recovery_checkpoint_not_applied:${loaded.state.state}`)
  }
  if (!(await matchRecoverySide(loaded.manifest.repoRoot, loaded.manifest.entries, 'after'))) {
    await writeRecoveryState(
      loaded.artifactDir,
      'conflict',
      loaded.manifestHash,
      RECOVERY_RESTORE_CONFLICT,
    )
    throw new Error(RECOVERY_RESTORE_CONFLICT)
  }

  const rollbackDir = await mkdtemp(path.join(os.tmpdir(), 'belay-recovery-rollback-'))
  const rollback: Array<{
    path: string
    target: string
    before: RecoveryFileSnapshotV2
    after: RecoveryFileSnapshotV2
  }> = []
  try {
    for (const entry of loaded.manifest.entries) {
      const target = await assertRecoverySafeTarget(loaded.manifest.repoRoot, entry.path)
      const snapshot = await captureRecoverySnapshot(target, {
        blobDir: path.join(rollbackDir, 'blobs'),
      })
      rollback.push({ path: entry.path, target, before: snapshot, after: snapshot })
    }
    const capturedPostStateMatches = rollback.every((item, index) => {
      const expected = loaded.manifest.entries[index]?.after
      return (
        expected !== undefined &&
        recoverySnapshotHash(withoutRecoveryBlob(item.before)) ===
          recoverySnapshotHash(withoutRecoveryBlob(expected))
      )
    })
    if (!capturedPostStateMatches) {
      await writeRecoveryState(
        loaded.artifactDir,
        'conflict',
        loaded.manifestHash,
        RECOVERY_RESTORE_CONFLICT,
      )
      throw new Error(RECOVERY_RESTORE_CONFLICT)
    }
    await writeRecoveryState(loaded.artifactDir, 'restoring', loaded.manifestHash)
    try {
      for (const entry of sortRecoveryEntriesForSide(loaded.manifest.entries, 'before')) {
        const target = await assertRecoverySafeTarget(loaded.manifest.repoRoot, entry.path)
        await applyRecoverySnapshot(
          target,
          entry.before,
          loaded.artifactDir,
          RECOVERY_CHECKPOINT_CORRUPT,
        )
      }
      if (!(await matchRecoverySide(loaded.manifest.repoRoot, loaded.manifest.entries, 'before'))) {
        throw new Error('recovery_restore_verification_failed')
      }
      await writeRecoveryState(loaded.artifactDir, 'restored', loaded.manifestHash)
      return { manifestHash: loaded.manifestHash, changeCount: loaded.manifest.entries.length }
    } catch (error) {
      let rollbackFailed = false
      for (const item of sortRecoveryEntriesForSide(rollback, 'before')) {
        try {
          await applyRecoverySnapshot(
            item.target,
            item.before,
            rollbackDir,
            RECOVERY_CHECKPOINT_CORRUPT,
          )
        } catch {
          rollbackFailed = true
        }
      }
      const rollbackVerified =
        !rollbackFailed &&
        (await matchRecoverySide(loaded.manifest.repoRoot, loaded.manifest.entries, 'after'))
      await writeRecoveryState(
        loaded.artifactDir,
        rollbackVerified ? 'applied' : 'needs_manual_repair',
        loaded.manifestHash,
        error instanceof Error ? error.message : 'recovery_restore_failed',
      )
      throw error
    }
  } finally {
    await rm(rollbackDir, { recursive: true, force: true }).catch(() => {})
  }
}
