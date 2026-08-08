import type { ClassifyResult } from '../types.js'

export const RECOVERY_SUBSTRATE_UNAVAILABLE = 'recovery_substrate_unavailable'
export const RECOVERY_EXECUTION_FAILED = 'recovery_execution_failed'
export const RECOVERY_OBSERVED_RISK = 'recovery_observed_risk'

export function recoveryFailClosedResult(
  predicted: ClassifyResult,
  reason: string,
  signals: string[] = [],
): ClassifyResult {
  return {
    ...predicted,
    verdict: 'deny_pending_approval',
    reason,
    assessment: {
      ...predicted.assessment,
      reversibility: 'irreversible',
      confidence: 1,
      signals: [...predicted.assessment.signals, 'recovery_fail_closed', ...signals],
    },
  }
}
