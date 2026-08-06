import { describe, expect, it } from 'vitest'

import { policyDecisionToLegacyReason } from '../../core/capability/policy-bridge.js'

describe('policyDecisionToLegacyReason', () => {
  it('maps policy_default to outside_repo_mutation when outsideMutation is set', () => {
    const reason = policyDecisionToLegacyReason(
      {
        outcome: 'require_approval',
        reason: 'policy_default',
        signals: ['default_deny'],
        matchedRule: 'default.require_approval',
      },
      { outsideMutation: true, effect: 'local_mutation' },
    )
    expect(reason).toBe('outside_repo_mutation')
  })

  it('maps policy_default to unknown_local_effect for non-outside segments', () => {
    const reason = policyDecisionToLegacyReason({
      outcome: 'require_approval',
      reason: 'policy_default',
      signals: ['default_deny'],
      matchedRule: 'default.require_approval',
    })
    expect(reason).toBe('unknown_local_effect')
  })
})
