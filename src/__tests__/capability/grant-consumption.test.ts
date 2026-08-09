import { describe, expect, it } from 'vitest'

import {
  canConsumeCapabilityGrantLease,
  capabilityGrantLeaseRequired,
} from '../../core/capability/grant-consumption.js'
import type { ClassifyResult } from '../../core/types.js'

function classify(overrides: Partial<ClassifyResult> = {}): ClassifyResult {
  return {
    verdict: 'allow',
    reason: 'read_only',
    fingerprint: 'fp',
    assessment: {
      reversibility: 'reversible',
      external: false,
      blastRadius: 'local',
      confidence: 1,
      signals: [],
    },
    ...overrides,
  }
}

describe('grant consumption guards', () => {
  it('requires lease when grant.exact matched', () => {
    expect(
      capabilityGrantLeaseRequired(
        classify({
          authorizationDecision: {
            outcome: 'allow',
            reason: 'capability_grant',
            signals: [],
            matchedRule: 'grant.exact',
          },
        }),
      ),
    ).toBe(true)
  })

  it('fails closed when grant lease is required but requests are missing', () => {
    expect(
      canConsumeCapabilityGrantLease(
        classify({
          reason: 'capability_grant',
          capabilityRequests: [],
        }),
      ),
    ).toBe(false)
  })

  it('allows skip when no grant lease is required', () => {
    expect(canConsumeCapabilityGrantLease(classify({ reason: 'read_only' }))).toBe(true)
  })
})
