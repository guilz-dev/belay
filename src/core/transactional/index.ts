export {
  applyObservedChanges,
  buildObservedChangesFromTransactional,
  TRANSACTIONAL_APPLY_CONFLICT,
  TRANSACTIONAL_APPLY_ROLLBACK_FAILED,
  TRANSACTIONAL_APPLY_TOCTOU,
} from './apply-observed-changes.js'
export type {
  TransactionalBackend,
  TransactionalBackendContext,
  TransactionalBackendId,
  TransactionalBackendProbe,
  TransactionalBackendSelection,
  TransactionalSnapshot,
} from './backend.js'
export {
  FILE_CHECKPOINT_DISABLED,
  FILE_CHECKPOINT_DURABLE_REQUIRED,
  FILE_CHECKPOINT_ISOLATION_UNAVAILABLE,
  FILE_CHECKPOINT_NON_GIT_DISABLED,
  FILE_CHECKPOINT_NOT_IMPLEMENTED,
  probeTransactionalBackends,
  selectTransactionalBackend,
} from './backend-selector.js'
export { evaluateTransactionalDiff } from './diff-evaluator.js'
export { isTransactionalEligible } from './eligibility.js'
export {
  FILE_CHECKPOINT_PROTECTED_PATH_CHANGED,
  fileCheckpointBackend,
} from './file-checkpoint-backend.js'
export {
  FILE_CHECKPOINT_CWD_OUTSIDE_ROOT,
  FILE_CHECKPOINT_GIT_METADATA_CHANGED,
  FILE_CHECKPOINT_SOURCE_CHANGED,
  FILE_CHECKPOINT_SPLIT_INDEX_UNSUPPORTED,
  resolveExecutionCwdRelative,
} from './file-checkpoint-git.js'
export {
  collectDeadOwnerStaging,
  type FileCheckpointOwnerMarker,
  isOwnerProcessAlive,
  removeDeadOwnerStaging,
  writeOwnerMarker,
} from './file-checkpoint-staging.js'
export {
  cloneDirectoryTree,
  type FileCloneResult,
  type FileCloneStrategy,
  probeFileCloneStrategy,
} from './file-clone.js'
export {
  buildFileTreeIndex,
  diffFileTreeIndices,
  FileCheckpointDiagnosticError,
  type FileTreeEntry,
  type FileTreeIndex,
  type ObservedFileChange,
  readObservedChanges,
} from './file-tree.js'
export {
  compareRelativePathsBytewise,
  joinRelativePath,
  validateRelativePath,
} from './file-tree-path.js'
export { gitWorktreeBackend } from './git-worktree-backend.js'
export {
  TRANSACTIONAL_ALREADY_APPLIED,
  TRANSACTIONAL_APPROVAL_BYPASS_REASONS,
  TRANSACTIONAL_OBSERVED_RISK,
} from './reasons.js'
export { runTransactionalExecution } from './runner.js'
export {
  hashDirectoryNode,
  hashFileContent,
  type PresentSnapshotNode,
  readSnapshotNode,
  type SnapshotNode,
  snapshotNodesEqual,
} from './snapshot-node.js'
export type {
  TransactionalDiffEvaluation,
  TransactionalExecutionResult,
  TransactionalFileChange,
  TransactionalRunnerParams,
} from './types.js'
