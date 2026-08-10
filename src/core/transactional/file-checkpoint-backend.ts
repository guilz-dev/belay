import { cp, lstat, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { attestsWorkspaceMountIsolation } from '../capability/attestation.js'
import { currentRecoveryResourceIdentity } from '../recovery/resource-identity.js'
import type {
  TransactionalBackend,
  TransactionalBackendContext,
  TransactionalBackendProbe,
  TransactionalSnapshot,
} from './backend.js'
import {
  FILE_CHECKPOINT_DISABLED,
  FILE_CHECKPOINT_DURABLE_REQUIRED,
  FILE_CHECKPOINT_ISOLATION_UNAVAILABLE,
} from './backend-selector.js'
import {
  cloneBareWorktreeCopy,
  computeGitMetadataFingerprint,
  copyGitIndexState,
  execGit,
  FILE_CHECKPOINT_BASELINE_MISMATCH,
  FILE_CHECKPOINT_CWD_OUTSIDE_ROOT,
  FILE_CHECKPOINT_GIT_METADATA_CHANGED,
  FILE_CHECKPOINT_PREPARE_FAILED,
  removeAllGitRemotes,
  resolveExecutionCwdRelative,
} from './file-checkpoint-git.js'
import { removeDeadOwnerStaging, writeOwnerMarker } from './file-checkpoint-staging.js'
import { cloneDirectoryTree, probeFileCloneStrategy } from './file-clone.js'
import {
  buildFileTreeIndex,
  diffFileTreeIndices,
  FILE_CHECKPOINT_PREPARE_TIMEOUT,
  FILE_CHECKPOINT_QUOTA_EXCEEDED,
  type FileTreeIndex,
} from './file-tree.js'
import { isDirtyWorktree, isGitWorktreeAvailable } from './git-worktree.js'
import type { TransactionalFileChange } from './types.js'

function fileCheckpointIsolationReason(context: TransactionalBackendContext): string | null {
  const attestation = context.boundaryAttestation
  const fresh = context.boundaryAttestationFresh === true
  const driverId = context.boundaryDriverId
  if (!attestation || !fresh || !driverId) {
    return FILE_CHECKPOINT_ISOLATION_UNAVAILABLE
  }
  if (attestation.driver !== driverId) {
    return FILE_CHECKPOINT_ISOLATION_UNAVAILABLE
  }
  if (!attestsWorkspaceMountIsolation(attestation)) {
    return FILE_CHECKPOINT_ISOLATION_UNAVAILABLE
  }
  return null
}

async function probeDirtyGitFileCheckpoint(
  context: TransactionalBackendContext,
): Promise<TransactionalBackendProbe> {
  const signals = ['git_repository', 'dirty_git_worktree']
  if (!(await isGitWorktreeAvailable(context.repoRoot))) {
    return {
      eligible: false,
      backend: 'file_checkpoint',
      reason: 'git_worktree_unavailable',
      signals: ['git_repository'],
    }
  }
  if (!(await isDirtyWorktree(context.repoRoot, { ignoreRoots: context.dirtyIgnoreRoots }))) {
    return {
      eligible: false,
      backend: 'file_checkpoint',
      reason: 'clean_git_worktree',
      signals: ['git_repository', 'clean_git_worktree'],
    }
  }
  if (!context.fileCheckpoint.enabled) {
    return {
      eligible: false,
      backend: 'file_checkpoint',
      reason: FILE_CHECKPOINT_DISABLED,
      signals,
    }
  }
  if (!context.durableCheckpointEnabled) {
    return {
      eligible: false,
      backend: 'file_checkpoint',
      reason: FILE_CHECKPOINT_DURABLE_REQUIRED,
      signals,
    }
  }
  const isolationReason = fileCheckpointIsolationReason(context)
  if (isolationReason) {
    return {
      eligible: false,
      backend: 'file_checkpoint',
      reason: isolationReason,
      signals: [...signals, 'isolation_unavailable'],
    }
  }

  const copyStrategy = await probeFileCloneStrategy()
  return {
    eligible: true,
    backend: 'file_checkpoint',
    signals: [...signals, 'dirty_git_file_checkpoint', copyStrategy],
  }
}

interface PreparedFileCheckpointState {
  stagingRoot: string
  baselineRoot: string
  executionRoot: string
  baselineIndex: FileTreeIndex
  sourceGitMetadataFingerprint: string
  gitMetadataFingerprint: string
  copyStrategy: 'clonefile' | 'reflink' | 'copy'
}

async function directoryByteSize(root: string, deadlineMs: number): Promise<number> {
  if (Date.now() > deadlineMs) {
    throw new Error(FILE_CHECKPOINT_PREPARE_TIMEOUT)
  }
  const info = await lstat(root)
  if (!info.isDirectory() || info.isSymbolicLink()) {
    return info.size
  }
  let total = 0
  for (const name of await readdir(root)) {
    total += await directoryByteSize(path.join(root, name), deadlineMs)
  }
  return total
}

async function copyGitMetadataDirectory(
  sourceRoot: string,
  destinationRoot: string,
): Promise<void> {
  const gitDirRel = (await execGit(sourceRoot, ['rev-parse', '--git-dir'])).trim()
  const sourceGitDir = path.isAbsolute(gitDirRel) ? gitDirRel : path.join(sourceRoot, gitDirRel)
  const relativeGitDir = path.relative(path.resolve(sourceRoot), path.resolve(sourceGitDir))
  const destinationGitDir =
    relativeGitDir && !relativeGitDir.startsWith('..')
      ? path.join(destinationRoot, relativeGitDir)
      : path.join(destinationRoot, '.git')
  await cp(sourceGitDir, destinationGitDir, { recursive: true, force: true })
}

async function prepareDirtyGitSnapshot(
  context: TransactionalBackendContext,
): Promise<PreparedFileCheckpointState> {
  const excludedRoots = context.dirtyIgnoreRoots ?? []
  const quotas = context.fileCheckpoint
  const deadlineMs = Date.now() + quotas.prepareTimeoutMs

  await removeDeadOwnerStaging(os.tmpdir())
  const stagingRoot = await mkdtemp(path.join(os.tmpdir(), 'belay-file-checkpoint-'))
  await writeOwnerMarker(stagingRoot, {
    version: 1,
    pid: process.pid,
    createdAt: new Date().toISOString(),
    resourceRoot: context.repoRoot,
    backend: 'file_checkpoint',
  })

  const baselineRoot = path.join(stagingRoot, 'baseline')
  const executionRoot = path.join(stagingRoot, 'execution')

  try {
    resolveExecutionCwdRelative(context.repoRoot, context.cwd)
    const sourceGitMetadataFingerprint = await computeGitMetadataFingerprint(context.repoRoot)
    await cloneBareWorktreeCopy(context.repoRoot, baselineRoot)
    await removeAllGitRemotes(baselineRoot)
    const baselineCopy = await cloneDirectoryTree(context.repoRoot, baselineRoot, {
      excludedRoots,
      quotas,
      deadlineMs,
    })
    await copyGitIndexState(context.repoRoot, baselineRoot)

    const baselineIndex = await buildFileTreeIndex({
      resourceRoot: baselineRoot,
      excludedRoots,
      quotas,
      deadlineMs,
    })
    const sourceIndex = await buildFileTreeIndex({
      resourceRoot: context.repoRoot,
      excludedRoots,
      quotas,
      deadlineMs,
    })
    if (sourceIndex.treeHash !== baselineIndex.treeHash) {
      throw new Error(FILE_CHECKPOINT_BASELINE_MISMATCH)
    }
    if ((await computeGitMetadataFingerprint(context.repoRoot)) !== sourceGitMetadataFingerprint) {
      throw new Error(FILE_CHECKPOINT_BASELINE_MISMATCH)
    }

    await writeFile(
      path.join(stagingRoot, 'baseline-index.json'),
      `${JSON.stringify(baselineIndex)}\n`,
      'utf8',
    )

    const executionCopy = await cloneDirectoryTree(baselineRoot, executionRoot, {
      excludedRoots,
      quotas,
      deadlineMs,
    })
    await copyGitMetadataDirectory(baselineRoot, executionRoot)
    const gitMetadataFingerprint = await computeGitMetadataFingerprint(executionRoot)
    if ((await directoryByteSize(stagingRoot, deadlineMs)) > quotas.maxWorkspaceBytes) {
      throw new Error(FILE_CHECKPOINT_QUOTA_EXCEEDED)
    }

    return {
      stagingRoot,
      baselineRoot,
      executionRoot,
      baselineIndex,
      sourceGitMetadataFingerprint,
      gitMetadataFingerprint,
      copyStrategy:
        executionCopy.strategy === baselineCopy.strategy ? executionCopy.strategy : 'copy',
    }
  } catch (error) {
    await rm(stagingRoot, { recursive: true, force: true })
    if (error instanceof Error && error.message === FILE_CHECKPOINT_CWD_OUTSIDE_ROOT) {
      throw error
    }
    if (error instanceof Error && error.message === FILE_CHECKPOINT_BASELINE_MISMATCH) {
      throw error
    }
    throw new Error(error instanceof Error ? error.message : FILE_CHECKPOINT_PREPARE_FAILED, {
      cause: error,
    })
  }
}

export const fileCheckpointBackend: TransactionalBackend = {
  id: 'file_checkpoint',

  probe: probeDirtyGitFileCheckpoint,

  async prepare(context: TransactionalBackendContext): Promise<TransactionalSnapshot> {
    const probe = await probeDirtyGitFileCheckpoint(context)
    if (!probe.eligible) {
      throw new Error(probe.reason ?? FILE_CHECKPOINT_PREPARE_FAILED)
    }

    const prepared = await prepareDirtyGitSnapshot(context)
    const executionCwdRelative = resolveExecutionCwdRelative(context.repoRoot, context.cwd)
    const resourceIdentity = await currentRecoveryResourceIdentity(
      context.repoRoot,
      'git_repository',
    )

    return {
      backend: 'file_checkpoint',
      resourceRoot: context.repoRoot,
      executionRoot: prepared.executionRoot,
      baselineRoot: prepared.baselineRoot,
      resourceIdentity,
      baselineTreeHash: prepared.baselineIndex.treeHash,
      excludedRoots: context.dirtyIgnoreRoots ?? [],
      copyStrategy: prepared.copyStrategy,
      executionCwdRelative,
      async validateSourceState() {
        const sourceIndex = await buildFileTreeIndex({
          resourceRoot: context.repoRoot,
          excludedRoots: context.dirtyIgnoreRoots ?? [],
          quotas: context.fileCheckpoint,
        })
        if (
          sourceIndex.treeHash !== prepared.baselineIndex.treeHash ||
          (await computeGitMetadataFingerprint(context.repoRoot)) !==
            prepared.sourceGitMetadataFingerprint
        ) {
          throw new Error(FILE_CHECKPOINT_BASELINE_MISMATCH)
        }
      },
      async collectChanges() {
        const afterFingerprint = await computeGitMetadataFingerprint(prepared.executionRoot)
        if (afterFingerprint !== prepared.gitMetadataFingerprint) {
          throw new Error(FILE_CHECKPOINT_GIT_METADATA_CHANGED)
        }

        const executionIndex = await buildFileTreeIndex({
          resourceRoot: prepared.executionRoot,
          excludedRoots: context.dirtyIgnoreRoots ?? [],
          quotas: context.fileCheckpoint,
        })
        const observed = diffFileTreeIndices(prepared.baselineIndex, executionIndex)
        return observed.map(
          (change): TransactionalFileChange => ({
            relativePath: change.relativePath,
            kind: change.kind,
          }),
        )
      },
      async cleanup() {
        await rm(prepared.stagingRoot, { recursive: true, force: true })
      },
    }
  },
}
