import { describe, expect, it } from 'vitest'

import { evaluateEgressConnect } from '../core/egress/policy.js'
import type { ApprovalStateFile } from '../core/types.js'

const repoRoot = '/workspace/project'
const emptyApproved: ApprovalStateFile = { version: 1, approvals: [] }

describe('evaluateEgressConnect', () => {
  it('allows read-only HTTP methods by default', () => {
    const result = evaluateEgressConnect({
      request: { host: 'api.example.com', port: 443, method: 'GET', repoRoot },
      allowlist: { version: 1, domains: [] },
      approved: emptyApproved,
    })
    expect(result.decision).toBe('allow')
    expect(result.reason).toBe('egress_read')
  })

  it('requires approval for CONNECT on unknown hosts', () => {
    const result = evaluateEgressConnect({
      request: { host: 'api.example.com', port: 443, method: 'CONNECT', repoRoot },
      allowlist: { version: 1, domains: [] },
      approved: emptyApproved,
    })
    expect(result.decision).toBe('deny_pending')
    expect(result.reason).toBe('egress_connect_requires_approval')
  })

  it('requires approval for payload-bearing read methods', () => {
    const result = evaluateEgressConnect({
      request: {
        host: 'api.example.com',
        port: 443,
        method: 'GET',
        hasPayload: true,
        repoRoot,
      },
      allowlist: { version: 1, domains: [] },
      approved: emptyApproved,
    })
    expect(result.decision).toBe('deny_pending')
    expect(result.reason).toBe('egress_read_with_payload_requires_approval')
  })

  it('allows allowlisted domains for mutating methods', () => {
    const result = evaluateEgressConnect({
      request: { host: 'api.example.com', port: 443, method: 'POST', repoRoot },
      allowlist: {
        version: 1,
        domains: [{ host: 'api.example.com', approvedAt: new Date().toISOString() }],
      },
      approved: emptyApproved,
    })
    expect(result.decision).toBe('allow')
    expect(result.reason).toBe('egress_allowlist')
  })

  it('allows allowlisted domains for CONNECT', () => {
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

  it('allows one-shot approved fingerprints for mutating methods', () => {
    const fingerprint = evaluateEgressConnect({
      request: { host: 'api.example.com', port: 443, method: 'POST', repoRoot },
      allowlist: { version: 1, domains: [] },
      approved: emptyApproved,
    }).fingerprint

    const result = evaluateEgressConnect({
      request: { host: 'api.example.com', port: 443, method: 'POST', repoRoot },
      allowlist: { version: 1, domains: [] },
      approved: {
        version: 1,
        approvals: [
          {
            approvalId: 'belay_test',
            kind: 'egress',
            fingerprint,
            repoRoot,
            reason: 'egress_requires_approval',
            summary: 'POST api.example.com:443',
            createdAt: new Date().toISOString(),
            expiresAt: new Date(Date.now() + 60_000).toISOString(),
          },
        ],
      },
    })
    expect(result.decision).toBe('allow')
    expect(result.reason).toBe('approved_once')
  })

  it('distinguishes payload-bearing reads in approval fingerprints', () => {
    const denied = evaluateEgressConnect({
      request: {
        host: 'api.example.com',
        port: 443,
        method: 'GET',
        hasPayload: true,
        repoRoot,
      },
      allowlist: { version: 1, domains: [] },
      approved: emptyApproved,
    })

    const approved = evaluateEgressConnect({
      request: {
        host: 'api.example.com',
        port: 443,
        method: 'GET',
        hasPayload: true,
        repoRoot,
      },
      allowlist: { version: 1, domains: [] },
      approved: {
        version: 1,
        approvals: [
          {
            approvalId: 'belay_payload_read',
            kind: 'egress',
            fingerprint: denied.fingerprint,
            repoRoot,
            reason: denied.reason,
            summary: denied.summary,
            createdAt: new Date().toISOString(),
            expiresAt: new Date(Date.now() + 60_000).toISOString(),
          },
        ],
      },
    })

    const plainRead = evaluateEgressConnect({
      request: { host: 'api.example.com', port: 443, method: 'GET', repoRoot },
      allowlist: { version: 1, domains: [] },
      approved: emptyApproved,
    })

    expect(approved.decision).toBe('allow')
    expect(approved.reason).toBe('approved_once')
    expect(denied.fingerprint).not.toBe(plainRead.fingerprint)
    expect(denied.summary).toContain('(payload)')
  })

  it('asks for mutating methods on unknown hosts', () => {
    const result = evaluateEgressConnect({
      request: { host: 'api.example.com', port: 443, method: 'POST', repoRoot },
      allowlist: { version: 1, domains: [] },
      approved: emptyApproved,
    })
    expect(result.decision).toBe('deny_pending')
    expect(result.reason).toBe('egress_requires_approval')
  })
})
