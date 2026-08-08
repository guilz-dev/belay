export const TRANSACTIONAL_ALREADY_APPLIED = 'transactional_already_applied'
export const TRANSACTIONAL_OBSERVED_RISK = 'transactional_observed_risk'
export const TRANSACTIONAL_APPLY_FAILED = 'transactional_apply_failed'

export {
  RECOVERY_DIRTY_WORKTREE,
  RECOVERY_EXECUTION_FAILED,
  RECOVERY_SUBSTRATE_UNAVAILABLE,
} from '../recovery/fail-closed.js'

export const TRANSACTIONAL_APPROVAL_BYPASS_REASONS = new Set([
  TRANSACTIONAL_OBSERVED_RISK,
  TRANSACTIONAL_ALREADY_APPLIED,
  TRANSACTIONAL_APPLY_FAILED,
  'recovery_substrate_unavailable',
  'recovery_execution_failed',
  'recovery_dirty_worktree',
])
