import type {
  TransactionalBackendContext,
  TransactionalBackendProbe,
  TransactionalBackendSelection,
} from './backend.js'
import { isGitWorktreeAvailable } from './git-worktree.js'
import { gitWorktreeBackend } from './git-worktree-backend.js'

export const FILE_CHECKPOINT_DISABLED = 'file_checkpoint_disabled'
export const FILE_CHECKPOINT_NON_GIT_DISABLED = 'file_checkpoint_non_git_disabled'
export const FILE_CHECKPOINT_DURABLE_REQUIRED = 'file_checkpoint_durable_checkpoint_required'

function fileCheckpointProbe(reason: string, signals: string[]): TransactionalBackendProbe {
  return {
    eligible: false,
    backend: 'file_checkpoint',
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

async function probeFileCheckpointForGit(
  context: TransactionalBackendContext,
): Promise<TransactionalBackendProbe> {
  if (!context.fileCheckpoint.enabled) {
    return fileCheckpointProbe(FILE_CHECKPOINT_DISABLED, ['dirty_git_worktree'])
  }
  if (!context.durableCheckpointEnabled) {
    return fileCheckpointProbe(FILE_CHECKPOINT_DURABLE_REQUIRED, ['dirty_git_worktree'])
  }
  return fileCheckpointProbe(FILE_CHECKPOINT_DISABLED, ['dirty_git_worktree', 'not_implemented'])
}

async function probeFileCheckpointForNonGit(
  context: TransactionalBackendContext,
): Promise<TransactionalBackendProbe> {
  if (!context.fileCheckpoint.enabled) {
    return fileCheckpointProbe(FILE_CHECKPOINT_DISABLED, ['non_git_workspace'])
  }
  if (!context.fileCheckpoint.allowNonGit) {
    return fileCheckpointProbe(FILE_CHECKPOINT_NON_GIT_DISABLED, ['non_git_workspace'])
  }
  if (!context.durableCheckpointEnabled) {
    return fileCheckpointProbe(FILE_CHECKPOINT_DURABLE_REQUIRED, ['non_git_workspace'])
  }
  return fileCheckpointProbe(FILE_CHECKPOINT_DISABLED, ['non_git_workspace', 'not_implemented'])
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
    return {
      backend: null,
      probe: fileProbe,
      skipReason: 'dirty_worktree',
    }
  }

  const fileProbe = await probeFileCheckpointForNonGit(context)
  return {
    backend: null,
    probe: fileProbe,
    skipReason: 'git_worktree_unavailable',
  }
}
