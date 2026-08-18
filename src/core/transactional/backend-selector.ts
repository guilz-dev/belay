import type {
  TransactionalBackendContext,
  TransactionalBackendProbe,
  TransactionalBackendSelection,
} from './backend.js'
import { fileCheckpointBackend } from './file-checkpoint-backend.js'
import { fileCheckpointIsolationReason } from './file-checkpoint-isolation.js'
import { isDirtyWorktree, isGitWorktreeAvailable } from './git-worktree.js'
import { gitWorktreeBackend } from './git-worktree-backend.js'

export const FILE_CHECKPOINT_DISABLED = 'file_checkpoint_disabled'
export const FILE_CHECKPOINT_NON_GIT_DISABLED = 'file_checkpoint_non_git_disabled'
export const FILE_CHECKPOINT_DURABLE_REQUIRED = 'file_checkpoint_durable_checkpoint_required'
export { FILE_CHECKPOINT_ISOLATION_UNAVAILABLE } from './file-checkpoint-isolation.js'
export const FILE_CHECKPOINT_NOT_IMPLEMENTED = 'file_checkpoint_not_implemented'

function fileCheckpointProbe(
  reason: string,
  signals: string[],
  resourceKind: TransactionalBackendProbe['resourceKind'],
): TransactionalBackendProbe {
  return {
    eligible: false,
    backend: 'file_checkpoint',
    resourceKind,
    reason,
    signals,
  }
}

export async function probeTransactionalBackends(
  context: TransactionalBackendContext,
): Promise<TransactionalBackendProbe[]> {
  const probes: TransactionalBackendProbe[] = [await gitWorktreeBackend.probe(context)]

  if (await isGitWorktreeAvailable(context.repoRoot)) {
    probes.push(await probeFileCheckpointForGit(context))
  } else {
    probes.push(await probeFileCheckpointForNonGit(context))
  }

  return probes
}

export async function probeFileCheckpointBackend(
  context: TransactionalBackendContext,
): Promise<TransactionalBackendProbe> {
  const probes = await probeTransactionalBackends(context)
  const probe = probes.find((candidate) => candidate.backend === 'file_checkpoint')
  if (!probe) throw new Error(FILE_CHECKPOINT_NOT_IMPLEMENTED)
  return probe
}

async function gitWorkspaceSignals(context: TransactionalBackendContext): Promise<string[]> {
  const signals = ['git_repository']
  if (await isDirtyWorktree(context.repoRoot, { ignoreRoots: context.dirtyIgnoreRoots })) {
    signals.push('dirty_git_worktree')
  }
  return signals
}

async function probeFileCheckpointForGit(
  context: TransactionalBackendContext,
): Promise<TransactionalBackendProbe> {
  const signals = await gitWorkspaceSignals(context)
  if (!context.fileCheckpoint.enabled) {
    return fileCheckpointProbe(FILE_CHECKPOINT_DISABLED, signals, 'git_repository')
  }
  if (!context.durableCheckpointEnabled) {
    return fileCheckpointProbe(FILE_CHECKPOINT_DURABLE_REQUIRED, signals, 'git_repository')
  }
  const isolationReason = fileCheckpointIsolationReason(context)
  if (isolationReason) {
    return fileCheckpointProbe(
      isolationReason,
      [...signals, 'isolation_unavailable'],
      'git_repository',
    )
  }
  const backendProbe = await fileCheckpointBackend.probe(context)
  if (backendProbe.eligible) {
    return backendProbe
  }
  return fileCheckpointProbe(
    backendProbe.reason ?? FILE_CHECKPOINT_NOT_IMPLEMENTED,
    [
      ...signals,
      ...(backendProbe.reason === FILE_CHECKPOINT_NOT_IMPLEMENTED ? ['not_implemented'] : []),
    ],
    'git_repository',
  )
}

async function probeFileCheckpointForNonGit(
  context: TransactionalBackendContext,
): Promise<TransactionalBackendProbe> {
  if (!context.fileCheckpoint.enabled) {
    return fileCheckpointProbe(FILE_CHECKPOINT_DISABLED, ['non_git_workspace'], 'directory')
  }
  if (!context.fileCheckpoint.allowNonGit) {
    return fileCheckpointProbe(FILE_CHECKPOINT_NON_GIT_DISABLED, ['non_git_workspace'], 'directory')
  }
  if (!context.durableCheckpointEnabled) {
    return fileCheckpointProbe(FILE_CHECKPOINT_DURABLE_REQUIRED, ['non_git_workspace'], 'directory')
  }
  const isolationReason = fileCheckpointIsolationReason(context)
  if (isolationReason) {
    return fileCheckpointProbe(
      isolationReason,
      ['non_git_workspace', 'isolation_unavailable'],
      'directory',
    )
  }
  const backendProbe = await fileCheckpointBackend.probe(context)
  if (backendProbe.eligible) {
    return backendProbe
  }
  return fileCheckpointProbe(
    backendProbe.reason ?? FILE_CHECKPOINT_NOT_IMPLEMENTED,
    [
      'non_git_workspace',
      ...(backendProbe.reason === FILE_CHECKPOINT_NOT_IMPLEMENTED ? ['not_implemented'] : []),
    ],
    'directory',
  )
}

export async function selectTransactionalBackend(
  context: TransactionalBackendContext,
): Promise<TransactionalBackendSelection> {
  const gitProbe = await gitWorktreeBackend.probe(context)
  if (gitProbe.eligible) {
    return {
      backend: gitWorktreeBackend,
      probe: gitProbe,
    }
  }

  if (await isGitWorktreeAvailable(context.repoRoot)) {
    const fileProbe = await probeFileCheckpointForGit(context)
    if (fileProbe.eligible) {
      return {
        backend: fileCheckpointBackend,
        probe: fileProbe,
      }
    }
    return {
      backend: null,
      probe: fileProbe,
      skipReason: 'dirty_worktree',
    }
  }

  const fileProbe = await probeFileCheckpointForNonGit(context)
  if (fileProbe.eligible) {
    return {
      backend: fileCheckpointBackend,
      probe: fileProbe,
    }
  }
  return {
    backend: null,
    probe: fileProbe,
    skipReason: 'git_worktree_unavailable',
  }
}
