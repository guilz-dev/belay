export const TRANSACTIONAL_ALREADY_APPLIED = 'transactional_already_applied';
export const TRANSACTIONAL_OBSERVED_RISK = 'transactional_observed_risk';
export const TRANSACTIONAL_APPLY_FAILED = 'transactional_apply_failed';
export const TRANSACTIONAL_APPROVAL_BYPASS_REASONS = new Set([
    TRANSACTIONAL_OBSERVED_RISK,
    TRANSACTIONAL_ALREADY_APPLIED,
    TRANSACTIONAL_APPLY_FAILED,
]);
