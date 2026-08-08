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
  probeTransactionalBackends,
  selectTransactionalBackend,
} from './backend-selector.js'
export { evaluateTransactionalDiff } from './diff-evaluator.js'
export { isTransactionalEligible } from './eligibility.js'
export { gitWorktreeBackend } from './git-worktree-backend.js'
export {
  TRANSACTIONAL_ALREADY_APPLIED,
  TRANSACTIONAL_APPROVAL_BYPASS_REASONS,
  TRANSACTIONAL_OBSERVED_RISK,
} from './reasons.js'
export { runTransactionalExecution } from './runner.js'
export type {
  TransactionalDiffEvaluation,
  TransactionalExecutionResult,
  TransactionalFileChange,
  TransactionalRunnerParams,
} from './types.js'
