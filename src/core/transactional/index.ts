export {
  applyObservedChanges,
  buildObservedChangesFromTransactional,
  TRANSACTIONAL_APPLY_CONFLICT,
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
  FILE_CHECKPOINT_NON_GIT_DISABLED,
  FILE_CHECKPOINT_NOT_IMPLEMENTED,
  probeTransactionalBackends,
  selectTransactionalBackend,
} from './backend-selector.js'
export { evaluateTransactionalDiff } from './diff-evaluator.js'
export { isTransactionalEligible } from './eligibility.js'
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
