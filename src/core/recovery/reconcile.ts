import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import path from 'node:path'

import { hashValue } from '../fingerprint.js'
import {
  checkpointDir,
  ensureRecoveryReceipt,
  RECOVERY_CHECKPOINT_CORRUPT,
  readRecoveryArtifact,
  writeRecoveryState,
} from './artifact-store.js'
import {
  assertRecoverySafeTarget,
  recoverySnapshotMatches,
  withoutRecoveryBlob,
} from './snapshot-node.js'
import type { RecoveryCheckpointEntry, RecoveryCheckpointState } from './types.js'

export async function matchRecoverySide(
  resourceRoot: string,
  entries: RecoveryCheckpointEntry[],
  side: 'before' | 'after',
): Promise<boolean> {
  for (const entry of entries) {
    const target = await assertRecoverySafeTarget(resourceRoot, entry.path)
    if (!(await recoverySnapshotMatches(target, withoutRecoveryBlob(entry[side])))) return false
  }
  return true
}

export async function reconcileRecoveryCheckpoint(
  stateDir: string,
  checkpointId: string,
): Promise<RecoveryCheckpointState> {
  let loaded: Awaited<ReturnType<typeof readRecoveryArtifact>>
  try {
    loaded = await readRecoveryArtifact(stateDir, checkpointId)
  } catch {
    const artifactDir = checkpointDir(stateDir, checkpointId)
    if (existsSync(artifactDir)) {
      const manifestPath = path.join(artifactDir, 'manifest.json')
      const hash = existsSync(manifestPath)
        ? hashValue(await readFile(manifestPath, 'utf8'))
        : 'unavailable'
      await writeRecoveryState(artifactDir, 'corrupt', hash, RECOVERY_CHECKPOINT_CORRUPT)
    }
    return 'corrupt'
  }

  if (!['prepared', 'applying', 'restoring'].includes(loaded.state.state)) {
    return loaded.state.state
  }
  const before = await matchRecoverySide(
    loaded.manifest.repoRoot,
    loaded.manifest.entries,
    'before',
  )
  const after = await matchRecoverySide(loaded.manifest.repoRoot, loaded.manifest.entries, 'after')
  if (before) {
    const state = loaded.state.state === 'restoring' ? 'restored' : 'prepared'
    await writeRecoveryState(loaded.artifactDir, state, loaded.manifestHash)
    return state
  }
  if (after) {
    await ensureRecoveryReceipt(loaded.artifactDir, loaded.manifest, loaded.manifestHash)
    await writeRecoveryState(loaded.artifactDir, 'applied', loaded.manifestHash)
    return 'applied'
  }
  await writeRecoveryState(
    loaded.artifactDir,
    'needs_manual_repair',
    loaded.manifestHash,
    'mixed checkpoint state after interrupted operation',
  )
  return 'needs_manual_repair'
}
