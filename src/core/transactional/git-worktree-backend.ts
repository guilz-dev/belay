import type {
  TransactionalBackend,
  TransactionalBackendContext,
  TransactionalBackendProbe,
  TransactionalSnapshot,
} from './backend.js'
import {
  collectWorktreeChanges,
  createGitWorktreeSnapshot,
  isDirtyWorktree,
  isGitWorktreeAvailable,
} from './git-worktree.js'

async function probeGitWorktreeBackend(
  context: TransactionalBackendContext,
): Promise<TransactionalBackendProbe> {
  if (!(await isGitWorktreeAvailable(context.repoRoot))) {
    return {
      eligible: false,
      backend: 'git_worktree',
      reason: 'git_worktree_unavailable',
      signals: [],
    }
  }

  if (await isDirtyWorktree(context.repoRoot, { ignoreRoots: context.dirtyIgnoreRoots })) {
    return {
      eligible: false,
      backend: 'git_worktree',
      reason: 'dirty_worktree',
      signals: ['dirty_git_worktree'],
    }
  }

  return {
    eligible: true,
    backend: 'git_worktree',
    signals: ['clean_git_worktree'],
  }
}

export const gitWorktreeBackend: TransactionalBackend = {
  id: 'git_worktree',

  probe: probeGitWorktreeBackend,

  async prepare(context: TransactionalBackendContext): Promise<TransactionalSnapshot> {
    const probe = await probeGitWorktreeBackend(context)
    if (!probe.eligible) {
      throw new Error(probe.reason ?? 'git_worktree_unavailable')
    }

    const snapshot = await createGitWorktreeSnapshot(context.repoRoot, context.stateDir)
    return {
      backend: 'git_worktree',
      resourceRoot: context.repoRoot,
      executionRoot: snapshot.worktreePath,
      resourceIdentity: '',
      baselineTreeHash: '',
      excludedRoots: context.dirtyIgnoreRoots ?? [],
      async collectChanges() {
        return collectWorktreeChanges(snapshot.worktreePath)
      },
      async cleanup() {
        await snapshot.cleanup()
      },
    }
  },
}
