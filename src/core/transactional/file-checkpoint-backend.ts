import { cp, lstat, mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
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
  FILE_CHECKPOINT_NON_GIT_DISABLED,
} from './backend-selector.js'
import {
  assertRootGitMetadataUnchanged,
  cloneBareWorktreeCopy,
  computeGitMetadataFingerprint,
  copyGitIndexState,
  execGit,
  FILE_CHECKPOINT_CWD_OUTSIDE_ROOT,
  FILE_CHECKPOINT_GIT_METADATA_CHANGED,
  FILE_CHECKPOINT_PREPARE_FAILED,
  FILE_CHECKPOINT_SOURCE_CHANGED,
  removeAllGitRemotes,
  resolveExecutionCwdRelative,
  rethrowStableFileCheckpointError,
} from './file-checkpoint-git.js'
import { removeDeadOwnerStaging, writeOwnerMarker } from './file-checkpoint-staging.js'
import { cloneDirectoryTree, probeFileCloneStrategy } from './file-clone.js'
import {
  buildFileTreeIndex,
  diffFileTreeIndices,
  FILE_CHECKPOINT_PREPARE_TIMEOUT,
  FILE_CHECKPOINT_QUOTA_EXCEEDED,
  FileCheckpointDiagnosticError,
  type FileTreeIndex,
} from './file-tree.js'
import { isDirtyWorktree, isGitWorktreeAvailable } from './git-worktree.js'
import { readSnapshotNode } from './snapshot-node.js'
import type { TransactionalFileChange } from './types.js'

export const FILE_CHECKPOINT_PROTECTED_PATH_CHANGED = 'file_checkpoint_protected_path_changed'

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

async function probeNonGitFileCheckpoint(
  context: TransactionalBackendContext,
): Promise<TransactionalBackendProbe> {
  const signals = ['non_git_workspace']
  if (await isGitWorktreeAvailable(context.repoRoot)) {
    return {
      eligible: false,
      backend: 'file_checkpoint',
      reason: 'git_worktree_available',
      signals: ['git_repository'],
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
  if (!context.fileCheckpoint.allowNonGit) {
    return {
      eligible: false,
      backend: 'file_checkpoint',
      reason: FILE_CHECKPOINT_NON_GIT_DISABLED,
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
    signals: [...signals, 'non_git_file_checkpoint', copyStrategy],
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
  workspaceBytes: number
  prepareMs: number
  protectedRootStates: Map<string, string>
}

interface PreparedNonGitSnapshotState {
  stagingRoot: string
  baselineRoot: string
  executionRoot: string
  baselineIndex: FileTreeIndex
  resourceIdentity: string
  copyStrategy: 'clonefile' | 'reflink' | 'copy'
  workspaceBytes: number
  prepareMs: number
  protectedRootStates: Map<string, string>
}

async function protectedRootState(root: string): Promise<string> {
  const node = await readSnapshotNode(root)
  if (node.kind !== 'directory') {
    return `${node.kind}:${node.kind === 'absent' ? '' : node.hash}`
  }
  const index = await buildFileTreeIndex({ resourceRoot: root })
  return `directory:${node.hash}:${index.treeHash}`
}

function executionProtectedRoot(
  resourceRoot: string,
  executionRoot: string,
  protectedRoot: string,
): string | null {
  const relative = path.relative(path.resolve(resourceRoot), path.resolve(protectedRoot))
  if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) {
    return null
  }
  return path.join(executionRoot, relative)
}

async function captureProtectedRootStates(
  resourceRoot: string,
  executionRoot: string,
  protectedRoots: string[],
): Promise<Map<string, string>> {
  const states = new Map<string, string>()
  for (const protectedRoot of protectedRoots) {
    const executionPath = executionProtectedRoot(resourceRoot, executionRoot, protectedRoot)
    if (executionPath) {
      states.set(executionPath, await protectedRootState(executionPath))
    }
  }
  return states
}

async function directoryByteSize(root: string, deadlineMs: number): Promise<number> {
  if (Date.now() > deadlineMs) {
    throw new FileCheckpointDiagnosticError(
      FILE_CHECKPOINT_PREPARE_TIMEOUT,
      `workspace accounting exceeded deadlineMs=${deadlineMs}`,
    )
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
  const prepareStartedAt = Date.now()
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
    if (sourceIndex.treeHash !== baselineCopy.sourceIndex.treeHash) {
      throw new Error(FILE_CHECKPOINT_SOURCE_CHANGED)
    }
    if (sourceIndex.treeHash !== baselineIndex.treeHash) {
      throw new Error(FILE_CHECKPOINT_SOURCE_CHANGED)
    }
    if ((await computeGitMetadataFingerprint(context.repoRoot)) !== sourceGitMetadataFingerprint) {
      throw new Error(FILE_CHECKPOINT_SOURCE_CHANGED)
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
    const protectedRootStates = await captureProtectedRootStates(
      context.repoRoot,
      executionRoot,
      excludedRoots,
    )
    const workspaceBytes = await directoryByteSize(stagingRoot, deadlineMs)
    if (workspaceBytes > quotas.maxWorkspaceBytes) {
      throw new FileCheckpointDiagnosticError(
        FILE_CHECKPOINT_QUOTA_EXCEEDED,
        `snapshot workspaceBytes=${workspaceBytes} exceeds maxWorkspaceBytes=${quotas.maxWorkspaceBytes}`,
      )
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
      workspaceBytes,
      prepareMs: Date.now() - prepareStartedAt,
      protectedRootStates,
    }
  } catch (error) {
    await rm(stagingRoot, { recursive: true, force: true })
    if (error instanceof FileCheckpointDiagnosticError) {
      throw error
    }
    rethrowStableFileCheckpointError(error)
  }
}

async function prepareNonGitSnapshot(
  context: TransactionalBackendContext,
): Promise<PreparedNonGitSnapshotState> {
  const prepareStartedAt = Date.now()
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
    const resourceIdentity = await currentRecoveryResourceIdentity(context.repoRoot, 'directory')

    const baselineCopy = await cloneDirectoryTree(context.repoRoot, baselineRoot, {
      excludedRoots,
      quotas,
      deadlineMs,
    })
    await mkdir(baselineRoot, { recursive: true })

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
    if (sourceIndex.treeHash !== baselineCopy.sourceIndex.treeHash) {
      throw new Error(FILE_CHECKPOINT_SOURCE_CHANGED)
    }
    if (sourceIndex.treeHash !== baselineIndex.treeHash) {
      throw new Error(FILE_CHECKPOINT_SOURCE_CHANGED)
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
    await mkdir(executionRoot, { recursive: true })
    const finalSourceIndex = await buildFileTreeIndex({
      resourceRoot: context.repoRoot,
      excludedRoots,
      quotas,
      deadlineMs,
    })
    if (finalSourceIndex.treeHash !== baselineIndex.treeHash) {
      throw new Error(FILE_CHECKPOINT_SOURCE_CHANGED)
    }
    if (
      (await currentRecoveryResourceIdentity(context.repoRoot, 'directory')) !== resourceIdentity
    ) {
      throw new Error(FILE_CHECKPOINT_SOURCE_CHANGED)
    }
    const protectedRootStates = await captureProtectedRootStates(
      context.repoRoot,
      executionRoot,
      excludedRoots,
    )
    const workspaceBytes = await directoryByteSize(stagingRoot, deadlineMs)
    if (workspaceBytes > quotas.maxWorkspaceBytes) {
      throw new FileCheckpointDiagnosticError(
        FILE_CHECKPOINT_QUOTA_EXCEEDED,
        `snapshot workspaceBytes=${workspaceBytes} exceeds maxWorkspaceBytes=${quotas.maxWorkspaceBytes}`,
      )
    }

    return {
      stagingRoot,
      baselineRoot,
      executionRoot,
      baselineIndex,
      resourceIdentity,
      copyStrategy:
        executionCopy.strategy === baselineCopy.strategy ? executionCopy.strategy : 'copy',
      workspaceBytes,
      prepareMs: Date.now() - prepareStartedAt,
      protectedRootStates,
    }
  } catch (error) {
    await rm(stagingRoot, { recursive: true, force: true })
    if (error instanceof FileCheckpointDiagnosticError) {
      throw error
    }
    rethrowStableFileCheckpointError(error)
  }
}

function collectObservedChanges(
  prepared: Pick<
    PreparedFileCheckpointState | PreparedNonGitSnapshotState,
    'baselineIndex' | 'executionRoot' | 'protectedRootStates'
  >,
  context: TransactionalBackendContext,
): () => Promise<TransactionalFileChange[]> {
  return async () => {
    for (const [protectedRoot, before] of prepared.protectedRootStates) {
      if ((await protectedRootState(protectedRoot)) !== before) {
        throw new Error(FILE_CHECKPOINT_PROTECTED_PATH_CHANGED)
      }
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
  }
}

export const fileCheckpointBackend: TransactionalBackend = {
  id: 'file_checkpoint',

  async probe(context: TransactionalBackendContext): Promise<TransactionalBackendProbe> {
    if (await isGitWorktreeAvailable(context.repoRoot)) {
      return probeDirtyGitFileCheckpoint(context)
    }
    return probeNonGitFileCheckpoint(context)
  },

  async prepare(context: TransactionalBackendContext): Promise<TransactionalSnapshot> {
    if (await isGitWorktreeAvailable(context.repoRoot)) {
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
        resourceKind: 'git_repository',
        resourceIdentity,
        baselineTreeHash: prepared.baselineIndex.treeHash,
        excludedRoots: context.dirtyIgnoreRoots ?? [],
        copyStrategy: prepared.copyStrategy,
        snapshotFileCount: prepared.baselineIndex.fileCount,
        snapshotSourceBytes: prepared.baselineIndex.totalFileBytes,
        snapshotWorkspaceBytes: prepared.workspaceBytes,
        snapshotPrepareMs: prepared.prepareMs,
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
            throw new Error(FILE_CHECKPOINT_SOURCE_CHANGED)
          }
        },
        async collectChanges() {
          const afterFingerprint = await computeGitMetadataFingerprint(prepared.executionRoot)
          if (afterFingerprint !== prepared.gitMetadataFingerprint) {
            throw new Error(FILE_CHECKPOINT_GIT_METADATA_CHANGED)
          }
          return collectObservedChanges(prepared, context)()
        },
        async cleanup() {
          await rm(prepared.stagingRoot, { recursive: true, force: true })
        },
      }
    }

    const probe = await probeNonGitFileCheckpoint(context)
    if (!probe.eligible) {
      throw new Error(probe.reason ?? FILE_CHECKPOINT_PREPARE_FAILED)
    }

    const prepared = await prepareNonGitSnapshot(context)
    const executionCwdRelative = resolveExecutionCwdRelative(context.repoRoot, context.cwd)

    return {
      backend: 'file_checkpoint',
      resourceRoot: context.repoRoot,
      executionRoot: prepared.executionRoot,
      baselineRoot: prepared.baselineRoot,
      resourceKind: 'directory',
      resourceIdentity: prepared.resourceIdentity,
      baselineTreeHash: prepared.baselineIndex.treeHash,
      excludedRoots: context.dirtyIgnoreRoots ?? [],
      copyStrategy: prepared.copyStrategy,
      snapshotFileCount: prepared.baselineIndex.fileCount,
      snapshotSourceBytes: prepared.baselineIndex.totalFileBytes,
      snapshotWorkspaceBytes: prepared.workspaceBytes,
      snapshotPrepareMs: prepared.prepareMs,
      executionCwdRelative,
      async validateSourceState() {
        const sourceIndex = await buildFileTreeIndex({
          resourceRoot: context.repoRoot,
          excludedRoots: context.dirtyIgnoreRoots ?? [],
          quotas: context.fileCheckpoint,
        })
        if (
          sourceIndex.treeHash !== prepared.baselineIndex.treeHash ||
          (await currentRecoveryResourceIdentity(context.repoRoot, 'directory')) !==
            prepared.resourceIdentity
        ) {
          throw new Error(FILE_CHECKPOINT_SOURCE_CHANGED)
        }
      },
      collectChanges: async () => {
        await assertRootGitMetadataUnchanged(prepared.baselineRoot, prepared.executionRoot)
        return collectObservedChanges(prepared, context)()
      },
      async cleanup() {
        await rm(prepared.stagingRoot, { recursive: true, force: true })
      },
    }
  },
}
