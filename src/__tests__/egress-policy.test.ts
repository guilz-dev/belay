import { describe, expect, it } from 'vitest'

import { evaluateEgressConnect } from '../core/egress/policy.js'
import type { ApprovalStateFile } from '../core/types.js'

const repoRoot = '/workspace/project'
const emptyApproved: ApprovalStateFile = { version: 1, approvals: [] }

describe('evaluateEgressConnect', () => {
  it('denies unknown hosts by default', () => {
    const result = evaluateEgressConnect({
      request: { host: 'api.example.com', port: 443, method: 'CONNECT', repoRoot },
      allowlist: { version: 1, domains: [] },
      approved: emptyApproved,
    })
    expect(result.decision).toBe('deny_pending')
    expect(result.reason).toBe('egress_blocked')
  })

  it('allows allowlisted domains', () => {
    const result = evaluateEgressConnect({
      request: { host: 'api.example.com', port: 443, method: 'CONNECT', repoRoot },
      allowlist: {
        version: 1,
        domains: [{ host: 'api.example.com', approvedAt: new Date().toISOString() }],
      },
      approved: emptyApproved,
    })
    expect(result.decision).toBe('allow')
    expect(result.reason).toBe('egress_allowlist')
  })

  it('allows one-shot approved fingerprints', () => {
    const fingerprint = evaluateEgressConnect({
      request: { host: 'api.example.com', port: 443, method: 'CONNECT', repoRoot },
      allowlist: { version: 1, domains: [] },
      approved: emptyApproved,
    }).fingerprint

    const result = evaluateEgressConnect({
      request: { host: 'api.example.com', port: 443, method: 'CONNECT', repoRoot },
      allowlist: { version: 1, domains: [] },
      approved: {
        version: 1,
        approvals: [
          {
            approvalId: 'belay_test',
            kind: 'egress',
            fingerprint,
            repoRoot,
            reason: 'egress_blocked',
            summary: 'CONNECT api.example.com:443',
            createdAt: new Date().toISOString(),
            expiresAt: new Date(Date.now() + 60_000).toISOString(),
          },
        ],
      },
    })
    expect(result.decision).toBe('allow')
    expect(result.reason).toBe('approved_once')
  })
})
