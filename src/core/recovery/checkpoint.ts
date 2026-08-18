import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readdir, readFile, rename, rm } from 'node:fs/promises'
import path from 'node:path'

import type { BelayTransactionalConfig } from '../config.js'
import { canonicalStringify, hashValue } from '../fingerprint.js'
import { canonicalPath } from '../path-utils.js'
import { isGitWorktreeAvailable } from '../transactional/git-worktree.js'
import type { TransactionalFileChange } from '../transactional/types.js'
import {
  artifactRepoRoot,
  atomicWriteJson,
  checkpointDir,
  checkpointIds,
  checkpointIdsForRepo,
  checkpointsRoot,
  cleanupOrphanedStaging,
  directorySize,
  fsyncPath,
  markRecoveryCheckpointApplied,
  markRecoveryCheckpointApplying,
  type PreparedRecoveryCheckpoint,
  RECOVERY_CHECKPOINT_CORRUPT,
  readRecoveryArtifact,
  writeRecoveryState,
} from './artifact-store.js'
import { matchRecoverySide, reconcileRecoveryCheckpoint } from './reconcile.js'
import { currentRecoveryResourceIdentity, type RecoveryResourceKind } from './resource-identity.js'
import {
  RECOVERY_RESTORE_CONFLICT,
  RECOVERY_RESTORE_REASON,
  recoveryRestoreBinding,
  restoreRecoveryCheckpoint,
} from './restore.js'
import {
  assertRecoverySafeTarget,
  captureRecoverySnapshot,
  withoutRecoveryBlob,
} from './snapshot-node.js'
import type {
  RecoveryBackend,
  RecoveryCheckpointEntryV2,
  RecoveryCheckpointManifest,
  RecoveryCheckpointState,
  RecoveryCheckpointSummary,
  RecoveryProofV1,
} from './types.js'

async function resolveRecoveryResourceKind(
  backend: RecoveryBackend,
  repoRoot: string,
): Promise<RecoveryResourceKind> {
  if (backend === 'git_worktree') {
    return 'git_repository'
  }
  if (await isGitWorktreeAvailable(repoRoot)) {
    return 'git_repository'
  }
  return 'directory'
}

function recoveryProofProbeSignals(
  backend: RecoveryBackend,
  resourceKind: RecoveryResourceKind,
): string[] {
  if (backend === 'file_checkpoint') {
    if (resourceKind === 'directory') {
      return [
        'non_git_workspace',
        'non_git_file_checkpoint',
        'file_checkpoint',
        'observed_repo_local_diff',
      ]
    }
    return ['dirty_git_worktree', 'file_checkpoint', 'observed_repo_local_diff']
  }
  return ['clean_git_worktree', 'observed_repo_local_diff']
}

export const RECOVERY_CHECKPOINT_QUOTA = 'recovery_checkpoint_quota_exceeded'

type CheckpointConfig = NonNullable<BelayTransactionalConfig['checkpoint']>

async function garbageCollect(
  stateDir: string,
  config: CheckpointConfig,
  repoRoot: string,
): Promise<void> {
  const artifacts: Array<{
    id: string
    state: RecoveryCheckpointState
    updatedAt: number
  }> = []
  for (const id of await checkpointIdsForRepo(stateDir, repoRoot)) {
    try {
      const loaded = await readRecoveryArtifact(stateDir, id)
      artifacts.push({
        id,
        state: loaded.state.state,
        updatedAt: Date.parse(loaded.state.updatedAt),
      })
    } catch {
      // Corrupt checkpoints are retained for inspection.
    }
  }

  const now = Date.now()
  const removable = artifacts
    .filter((entry) => entry.state === 'applied' || entry.state === 'restored')
    .sort((left, right) => left.updatedAt - right.updatedAt)
  for (const entry of removable) {
    const retentionHours =
      entry.state === 'restored' ? config.restoredRetentionHours : config.appliedRetentionHours
    const expired = now - entry.updatedAt >= retentionHours * 60 * 60 * 1000
    if (!expired) continue
    await rm(checkpointDir(stateDir, entry.id), { recursive: true, force: true })
  }
}

export async function prepareRecoveryCheckpoint(params: {
  stateDir: string
  repoRoot: string
  /** Immutable pre-command source for recovery blobs, when available. */
  baselinePath?: string
  worktreePath: string
  commandFingerprint: string
  changes: TransactionalFileChange[]
  protectedRoots?: string[]
  config: CheckpointConfig
  backend?: RecoveryBackend
  /** Snapshot-time resource identity; re-validated before manifest commit. */
  expectedResourceIdentity?: string
}): Promise<PreparedRecoveryCheckpoint> {
  const backend = params.backend ?? 'git_worktree'
  const resourceKind = await resolveRecoveryResourceKind(backend, params.repoRoot)
  await mkdir(checkpointsRoot(params.stateDir), { recursive: true, mode: 0o700 })
  await cleanupOrphanedStaging(params.stateDir)
  await garbageCollect(params.stateDir, params.config, params.repoRoot)
  const existing = await checkpointIdsForRepo(params.stateDir, params.repoRoot)
  if (existing.length >= params.config.maxCheckpoints) {
    throw new Error(RECOVERY_CHECKPOINT_QUOTA)
  }

  const checkpointId = `cp_${randomUUID().replaceAll('-', '').slice(0, 24)}`
  const temporary = path.join(checkpointsRoot(params.stateDir), `.tmp-${checkpointId}`)
  const finalDir = checkpointDir(params.stateDir, checkpointId)
  await mkdir(temporary, { recursive: true, mode: 0o700 })
  await atomicWriteJson(path.join(temporary, 'owner.json'), {
    version: 1,
    pid: process.pid,
    createdAt: new Date().toISOString(),
    repoRoot: canonicalPath(params.repoRoot),
  })
  await mkdir(path.join(temporary, 'blobs'), { recursive: true, mode: 0o700 })

  try {
    const entries: RecoveryCheckpointEntryV2[] = []
    const protectedRoots = (params.protectedRoots ?? []).map(canonicalPath)
    for (const change of [...params.changes].sort((left, right) =>
      left.relativePath.localeCompare(right.relativePath),
    )) {
      const target = await assertRecoverySafeTarget(params.repoRoot, change.relativePath)
      if (
        protectedRoots.some((root) => {
          const relative = path.relative(root, target)
          return (
            relative === '' ||
            (relative !== '..' &&
              !relative.startsWith(`..${path.sep}`) &&
              !path.isAbsolute(relative))
          )
        })
      ) {
        throw new Error('recovery_protected_path')
      }
      const baseline = await assertRecoverySafeTarget(
        params.baselinePath ?? params.repoRoot,
        change.relativePath,
      )
      const source = await assertRecoverySafeTarget(params.worktreePath, change.relativePath)
      entries.push({
        path: change.relativePath,
        before: await captureRecoverySnapshot(baseline, {
          blobDir: path.join(temporary, 'blobs'),
        }),
        after: withoutRecoveryBlob(await captureRecoverySnapshot(source)),
      })
    }

    const createdAt = new Date().toISOString()
    const repoIdentity = await currentRecoveryResourceIdentity(params.repoRoot, resourceKind)
    if (params.expectedResourceIdentity && repoIdentity !== params.expectedResourceIdentity) {
      throw new Error('recovery_checkpoint_repo_mismatch')
    }
    const proof: RecoveryProofV1 = {
      version: 1,
      backend,
      inputFingerprint: params.commandFingerprint,
      resourceScope: canonicalPath(params.repoRoot),
      baseStateHash: hashValue(canonicalStringify(entries.map((entry) => entry.before))),
      effectClosure: 'repo_local_fs_observed',
      issuedAt: createdAt,
      expiresAt: new Date(
        Date.now() + params.config.appliedRetentionHours * 60 * 60 * 1000,
      ).toISOString(),
      probeSignals: recoveryProofProbeSignals(backend, resourceKind),
    }
    const manifest: RecoveryCheckpointManifest = {
      version: 2,
      checkpointId,
      backend,
      repoRoot: canonicalPath(params.repoRoot),
      resourceKind,
      repoIdentity,
      commandFingerprint: params.commandFingerprint,
      createdAt,
      expiresAt: proof.expiresAt,
      proof,
      entries,
    }
    const manifestHash = hashValue(canonicalStringify(manifest))
    await atomicWriteJson(path.join(temporary, 'manifest.json'), manifest)
    await writeRecoveryState(temporary, 'prepared', manifestHash)
    await fsyncPath(temporary)

    const projectedBytes = await recoveryCheckpointStorageBytes(params.stateDir, params.repoRoot)
    if (projectedBytes > params.config.maxBytes) throw new Error(RECOVERY_CHECKPOINT_QUOTA)
    await rename(temporary, finalDir)
    await fsyncPath(checkpointsRoot(params.stateDir))
    return {
      checkpointId,
      manifest,
      manifestHash,
      proofHash: hashValue(canonicalStringify(proof)),
    }
  } catch (error) {
    await rm(temporary, { recursive: true, force: true })
    throw error
  }
}

export async function discardPreparedRecoveryCheckpoint(
  stateDir: string,
  checkpointId: string,
): Promise<boolean> {
  const state = await reconcileRecoveryCheckpoint(stateDir, checkpointId)
  if (state !== 'prepared') return false
  const loaded = await readRecoveryArtifact(stateDir, checkpointId)
  if (!(await matchRecoverySide(loaded.manifest.repoRoot, loaded.manifest.entries, 'before'))) {
    return false
  }
  await rm(loaded.artifactDir, { recursive: true, force: true })
  return true
}

export async function listRecoveryCheckpoints(
  stateDir: string,
  repoRoot?: string,
): Promise<RecoveryCheckpointSummary[]> {
  await cleanupOrphanedStaging(stateDir)
  const summaries: RecoveryCheckpointSummary[] = []
  for (const id of await checkpointIds(stateDir)) {
    if (repoRoot) {
      let rootFromArtifact: string | undefined
      try {
        rootFromArtifact = (await readRecoveryArtifact(stateDir, id)).manifest.repoRoot
      } catch {
        try {
          const raw = JSON.parse(
            await readFile(path.join(checkpointDir(stateDir, id), 'manifest.json'), 'utf8'),
          ) as { repoRoot?: unknown }
          rootFromArtifact =
            typeof raw.repoRoot === 'string' && raw.repoRoot ? raw.repoRoot : undefined
        } catch {
          rootFromArtifact = undefined
        }
      }
      if (!rootFromArtifact || canonicalPath(rootFromArtifact) !== canonicalPath(repoRoot)) continue
    }
    const state = await reconcileRecoveryCheckpoint(stateDir, id)
    try {
      const loaded = await readRecoveryArtifact(stateDir, id)
      if (repoRoot && canonicalPath(loaded.manifest.repoRoot) !== canonicalPath(repoRoot)) continue
      summaries.push({
        checkpointId: id,
        state,
        ...(loaded.state.detail ? { stateDetail: loaded.state.detail } : {}),
        backend: loaded.manifest.backend,
        resourceKind:
          loaded.manifest.version === 2 ? loaded.manifest.resourceKind : 'git_repository',
        repoRoot: loaded.manifest.repoRoot,
        commandFingerprint: loaded.manifest.commandFingerprint,
        createdAt: loaded.manifest.createdAt,
        expiresAt: loaded.manifest.expiresAt,
        changeCount: loaded.manifest.entries.length,
        manifestHash: loaded.manifestHash,
        ...(loaded.receipt
          ? {
              receiptHash: hashValue(canonicalStringify(loaded.receipt)),
              proofHash: loaded.receipt.proofHash,
              postStateHash: loaded.receipt.postStateHash,
            }
          : {}),
      })
    } catch {
      try {
        const manifest = JSON.parse(
          await readFile(path.join(checkpointDir(stateDir, id), 'manifest.json'), 'utf8'),
        ) as RecoveryCheckpointManifest
        if (manifest.checkpointId !== id || ![1, 2].includes(manifest.version)) continue
        if (repoRoot && canonicalPath(manifest.repoRoot) !== canonicalPath(repoRoot)) continue
        summaries.push({
          checkpointId: id,
          state: 'corrupt',
          backend: manifest.backend,
          resourceKind: manifest.version === 2 ? manifest.resourceKind : 'git_repository',
          repoRoot: manifest.repoRoot,
          commandFingerprint: manifest.commandFingerprint,
          createdAt: manifest.createdAt,
          expiresAt: manifest.expiresAt,
          changeCount: Array.isArray(manifest.entries) ? manifest.entries.length : 0,
          manifestHash: hashValue(canonicalStringify(manifest)),
        })
      } catch {
        // No trustworthy repository identity is available for this artifact.
      }
    }
  }
  return summaries.sort((left, right) => right.createdAt.localeCompare(left.createdAt))
}

export async function recoveryCheckpointStorageBytes(
  stateDir: string,
  repoRoot?: string,
): Promise<number> {
  const root = checkpointsRoot(stateDir)
  if (!repoRoot) return directorySize(root)
  if (!existsSync(root)) return 0
  const expected = canonicalPath(repoRoot)
  let total = 0
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const entryPath = path.join(root, entry.name)
    if (/^cp_[a-f0-9]{24}$/.test(entry.name)) {
      if ((await artifactRepoRoot(stateDir, entry.name)) === expected) {
        total += await directorySize(entryPath)
      }
      continue
    }
    if (/^\.tmp-cp_[a-f0-9]{24}$/.test(entry.name)) {
      try {
        const owner = JSON.parse(await readFile(path.join(entryPath, 'owner.json'), 'utf8')) as {
          repoRoot?: unknown
        }
        if (typeof owner.repoRoot === 'string' && canonicalPath(owner.repoRoot) === expected) {
          total += await directorySize(entryPath)
        }
      } catch {
        // Unattributable staging data is reconciled once it is stale.
      }
    }
  }
  return total
}

export async function showRecoveryCheckpoint(
  stateDir: string,
  checkpointId: string,
  expectedRepoRoot?: string,
) {
  if (
    expectedRepoRoot &&
    (await artifactRepoRoot(stateDir, checkpointId)) !== canonicalPath(expectedRepoRoot)
  ) {
    throw new Error('recovery_checkpoint_repo_mismatch')
  }
  await reconcileRecoveryCheckpoint(stateDir, checkpointId)
  return readRecoveryArtifact(stateDir, checkpointId)
}

export {
  markRecoveryCheckpointApplied,
  markRecoveryCheckpointApplying,
  RECOVERY_CHECKPOINT_CORRUPT,
  RECOVERY_RESTORE_CONFLICT,
  RECOVERY_RESTORE_REASON,
  reconcileRecoveryCheckpoint,
  recoveryRestoreBinding,
  restoreRecoveryCheckpoint,
}
