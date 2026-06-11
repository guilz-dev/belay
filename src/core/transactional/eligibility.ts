import type { BelayConfigV3 } from '../config.js'
import type { GatedActionKind } from '../gate-contract.js'
import type { ClassifyResult } from '../types.js'

const EXCLUDED_REASONS = new Set([
  'unparseable_shell',
  'external_effect',
  'l3_external_hint',
  'custom_external',
  'external_script',
  'outside_repo_redirect',
  'outside_repo_mutation',
  'control_plane_mutation',
  'dynamic_shell_evaluation',
  'pipe_to_shell',
  'command_substitution',
  'agent_assessment_mismatch',
  'find_dangerous_action',
  'read_only',
  'custom_allow',
])

export function isTransactionalEligible(
  config: BelayConfigV3,
  kind: GatedActionKind,
  result: ClassifyResult,
): boolean {
  const transactional = config.policy.transactional
  if (!transactional.enabled) {
    return false
  }
  if (kind !== 'shell' || !config.gates.shell || !transactional.gates.shell) {
    return false
  }
  if (EXCLUDED_REASONS.has(result.reason)) {
    return false
  }

  const { assessment } = result
  if (assessment.external) {
    return false
  }
  if (result.verdict === 'deny_pending_approval') {
    return false
  }
  if (result.verdict === 'allow' && assessment.confidence >= transactional.maxConfidence) {
    return false
  }

  const confidence = assessment.confidence
  if (confidence < transactional.minConfidence || confidence >= transactional.maxConfidence) {
    return false
  }

  return result.verdict === 'allow_flagged'
}
