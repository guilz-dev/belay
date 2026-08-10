import type { ResolvedBoundaryDriverContext } from '../capability/boundary-session.js'
import type { BelayFileCheckpointConfig, BelayTransactionalConfig } from '../config.js'
import type { Assessment, ClassifyResult, HookVerdict } from '../types.js'

export type TransactionalFileChangeKind = 'added' | 'modified' | 'deleted'

export interface TransactionalFileChange {
  relativePath: string
  kind: TransactionalFileChangeKind
}

export type TransactionalDiffCategory =
  | 'repo_local'
  | 'repo_outside'
  | 'sensitive_path'
  | 'control_plane'
  | 'large_deletion'

export interface TransactionalDiffEvaluation {
  verdict: HookVerdict
  reason: string
  categories: TransactionalDiffCategory[]
  changes: TransactionalFileChange[]
  deletedCount: number
  assessment: Assessment
}

export interface TransactionalExecutionResult {
  ok: boolean
  skipped?: boolean
  skipReason?: string
  predicted: ClassifyResult
  observed?: TransactionalDiffEvaluation
  result: ClassifyResult
  worktreePath?: string
  transactionalBackend?: 'git_worktree' | 'file_checkpoint'
  resourceKind?: 'git_repository' | 'directory'
  baselineTreeHash?: string
  snapshotFileCount?: number
  snapshotSourceBytes?: number
  snapshotWorkspaceBytes?: number
  snapshotCopyStrategy?: 'clonefile' | 'reflink' | 'copy'
  snapshotPrepareMs?: number
  commandExitCode?: number | null
  commandSignal?: string | null
  timedOut?: boolean
  recoveryCheckpointId?: string
  recoveryBackend?: 'git_worktree' | 'file_checkpoint'
  recoveryProofHash?: string
  recoveryState?: 'applied'
}

export interface GitWorktreeSnapshot {
  worktreePath: string
  cleanup: () => Promise<void>
}

export interface TransactionalDiffContext {
  repoRoot: string
  sensitivePaths: string[]
  protectedRoots: string[]
  maxDeletionCount: number
}

export interface TransactionalRunnerParams {
  command: string
  cwd: string
  repoRoot: string
  stateDir: string
  timeoutMs: number
  predicted: ClassifyResult
  diffContext: TransactionalDiffContext
  boundaryContext?: ResolvedBoundaryDriverContext
  /** Repo-local Belay paths excluded from dirty-worktree gating (init artifacts). */
  dirtyIgnoreRoots?: string[]
  fileCheckpoint: BelayFileCheckpointConfig
  checkpoint?: NonNullable<BelayTransactionalConfig['checkpoint']>
}
