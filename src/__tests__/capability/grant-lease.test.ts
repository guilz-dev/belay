import { describe, expect, it } from 'vitest'
import {
  mintCapabilityGrant,
  mintCapabilityGrantBundle,
} from '../../core/capability/approval-v3.js'
import {
  approvalGrantBundleExhausted,
  consumeApprovalGrantBundle,
  consumeApprovedRecordGrantBundle,
  consumeGrantLease,
  consumeGrantLeasesForRequests,
  findMatchingGrant,
  grantsFromApprovedState,
} from '../../core/capability/grant-lease.js'
import type { CapabilityRequestV1 } from '../../core/capability/request.js'
import type { ApprovalRecord } from '../../core/types.js'

const request: CapabilityRequestV1 = {
  version: 1,
  principal: { repoRoot: '/repo', sessionHash: 'sess' },
  action: 'fs.write',
  resource: { kind: 'path', path: '/repo/README.md' },
  context: {
    hookKind: 'shell',
    cwd: '/repo',
    inputFingerprint: 'fp1',
    analysisBasis: [],
  },
  evidence: {
    level: 'certain',
    signals: ['repo_local_write'],
  },
}

const networkRequest: CapabilityRequestV1 = {
  version: 1,
  principal: { repoRoot: '/repo', sessionHash: 'sess' },
  action: 'network.connect',
  resource: { kind: 'network', host: 'registry.npmjs.org', protocol: 'registry' },
  context: {
    hookKind: 'shell',
    cwd: '/repo',
    inputFingerprint: 'fp2',
    analysisBasis: [],
  },
  evidence: {
    level: 'possible',
    signals: ['package_acquire_possible'],
  },
}

function approvedWithGrant(): ApprovalRecord {
  const approval: ApprovalRecord = {
    approvalId: 'a1',
    kind: 'shell',
    fingerprint: 'fp',
    repoRoot: '/repo',
    reason: 'outside_repo_mutation',
    summary: 'echo hi',
    createdAt: '2026-01-01T00:00:00.000Z',
    expiresAt: '2099-01-02T00:00:00.000Z',
    approvedAt: '2026-01-01T00:01:00.000Z',
    capabilityRequests: [request],
  }
  const grant = mintCapabilityGrant({ approval, capabilityRequests: [request] })
  return { ...approval, grant: grant ?? undefined }
}

describe('grant lease', () => {
  it('loads active grants from approved state', () => {
    const grants = grantsFromApprovedState(
      { version: 3, approvals: [approvedWithGrant()] },
      '/repo',
    )
    expect(grants).toHaveLength(1)
    expect(findMatchingGrant(grants, request)?.grantId).toBe('grant_a1')
  })

  it('consumes grant uses atomically in memory', () => {
    const state = { version: 3 as const, approvals: [approvedWithGrant()] }
    const grant = grantsFromApprovedState(state, '/repo')[0]
    expect(grant?.grantId).toBe('grant_a1')
    if (!grant) {
      throw new Error('expected grant')
    }
    const consumed = consumeGrantLease(state, grant.grantId)
    expect(consumed.consumed).toBe(true)
    expect(consumed.state.approvals[0]?.grant?.usesRemaining).toBe(0)
    expect(consumed.state.approvals[0]?.grants?.[0]?.usesRemaining).toBe(0)
  })

  it('rejects second lease consumption for one-shot grants', () => {
    const state = { version: 3 as const, approvals: [approvedWithGrant()] }
    const grant = grantsFromApprovedState(state, '/repo')[0]
    expect(grant?.grantId).toBe('grant_a1')
    if (!grant) {
      throw new Error('expected grant')
    }
    const first = consumeGrantLease(state, grant.grantId)
    expect(first.consumed).toBe(true)
    const second = consumeGrantLease(first.state, grant.grantId)
    expect(second.consumed).toBe(false)
    expect(
      findMatchingGrant(grantsFromApprovedState(second.state, '/repo'), request),
    ).toBeUndefined()
  })

  it('consumes all grants in a bundle atomically', () => {
    const approval: ApprovalRecord = {
      approvalId: 'bundle1',
      kind: 'shell',
      fingerprint: 'fp',
      repoRoot: '/repo',
      reason: 'external_effect',
      summary: 'npx prettier',
      createdAt: '2026-01-01T00:00:00.000Z',
      expiresAt: '2099-01-02T00:00:00.000Z',
      approvedAt: '2026-01-01T00:01:00.000Z',
      capabilityRequests: [request, networkRequest],
    }
    const grants = mintCapabilityGrantBundle({
      approval,
      capabilityRequests: approval.capabilityRequests ?? [],
    })
    const record = { ...approval, grants, grant: grants[0] }
    const state = { version: 3 as const, approvals: [record] }

    const consumed = consumeGrantLeasesForRequests(state, [request, networkRequest])
    expect(consumed.consumed).toBe(true)
    expect(consumed.state.approvals[0]?.grants?.every((grant) => grant.usesRemaining === 0)).toBe(
      true,
    )
  })

  it('fails bundle consumption when any grant is missing', () => {
    const approval: ApprovalRecord = {
      approvalId: 'bundle2',
      kind: 'shell',
      fingerprint: 'fp',
      repoRoot: '/repo',
      reason: 'external_effect',
      summary: 'npx prettier',
      createdAt: '2026-01-01T00:00:00.000Z',
      expiresAt: '2099-01-02T00:00:00.000Z',
      approvedAt: '2026-01-01T00:01:00.000Z',
      capabilityRequests: [request, networkRequest],
    }
    const grants = mintCapabilityGrantBundle({
      approval,
      capabilityRequests: [request],
    })
    const record = { ...approval, grants, grant: grants[0] }
    const state = { version: 3 as const, approvals: [record] }

    const consumed = consumeGrantLeasesForRequests(state, [request, networkRequest])
    expect(consumed.consumed).toBe(false)
    expect(consumed.state).toBe(state)
  })

  it('does not compose a grant bundle across separate approval records', () => {
    const writeApproval: ApprovalRecord = {
      approvalId: 'split-write',
      kind: 'shell',
      fingerprint: 'fp-write',
      repoRoot: '/repo',
      reason: 'external_effect',
      summary: 'write',
      createdAt: '2026-01-01T00:00:00.000Z',
      expiresAt: '2099-01-02T00:00:00.000Z',
      approvedAt: '2026-01-01T00:01:00.000Z',
      capabilityRequests: [request],
    }
    const networkApproval: ApprovalRecord = {
      ...writeApproval,
      approvalId: 'split-network',
      fingerprint: 'fp-network',
      summary: 'network',
      capabilityRequests: [networkRequest],
    }
    const writeGrant = mintCapabilityGrant({
      approval: writeApproval,
      capabilityRequests: [request],
    })
    const networkGrant = mintCapabilityGrant({
      approval: networkApproval,
      capabilityRequests: [networkRequest],
    })
    const state = {
      version: 3 as const,
      approvals: [
        { ...writeApproval, grant: writeGrant ?? undefined },
        { ...networkApproval, grant: networkGrant ?? undefined },
      ],
    }

    const consumed = consumeGrantLeasesForRequests(state, [request, networkRequest])
    expect(consumed.consumed).toBe(false)
    expect(consumed.state).toBe(state)
  })

  it('consumes only grants from the matched approval bundle', () => {
    const approval: ApprovalRecord = {
      approvalId: 'bundle3',
      kind: 'shell',
      fingerprint: 'fp-match',
      repoRoot: '/repo',
      reason: 'external_effect',
      summary: 'npx prettier',
      createdAt: '2026-01-01T00:00:00.000Z',
      expiresAt: '2099-01-02T00:00:00.000Z',
      approvedAt: '2026-01-01T00:01:00.000Z',
      capabilityRequests: [request, networkRequest],
    }
    const grants = mintCapabilityGrantBundle({
      approval,
      capabilityRequests: approval.capabilityRequests ?? [],
    })
    const record = { ...approval, grants, grant: grants[0] }

    const consumed = consumeApprovalGrantBundle(record, [request, networkRequest])
    expect(consumed.consumed).toBe(true)
    expect(consumed.approval.grants?.every((grant) => grant.usesRemaining === 0)).toBe(true)
    expect(consumed.approval.grant?.usesRemaining).toBe(0)
    expect(approvalGrantBundleExhausted(consumed.approval)).toBe(true)
  })

  it('consumes broad network grants after approved-record replay validation', () => {
    const broadNetworkRequest: CapabilityRequestV1 = {
      ...networkRequest,
      resource: { kind: 'network', host: '*', protocol: 'unknown' },
    }
    const approval: ApprovalRecord = {
      approvalId: 'broad1',
      kind: 'shell',
      fingerprint: 'fp-broad',
      repoRoot: '/repo',
      reason: 'external_effect',
      summary: 'curl https://evil.example',
      createdAt: '2026-01-01T00:00:00.000Z',
      expiresAt: '2099-01-02T00:00:00.000Z',
      approvedAt: '2026-01-01T00:01:00.000Z',
      capabilityRequests: [broadNetworkRequest],
    }
    const grants = mintCapabilityGrantBundle({
      approval,
      capabilityRequests: [broadNetworkRequest],
    })
    const record = { ...approval, grants, grant: grants[0] }

    expect(consumeApprovalGrantBundle(record, [broadNetworkRequest]).consumed).toBe(false)
    const consumed = consumeApprovedRecordGrantBundle(record)
    expect(consumed.consumed).toBe(true)
    expect(consumed.approval.grants?.every((grant) => grant.usesRemaining === 0)).toBe(true)
  })

  it('rejects approved-record replay when any grant in the bundle is exhausted', () => {
    const approval: ApprovalRecord = {
      approvalId: 'partial-exhaustion',
      kind: 'shell',
      fingerprint: 'fp-partial',
      repoRoot: '/repo',
      reason: 'external_effect',
      summary: 'npx prettier',
      createdAt: '2026-01-01T00:00:00.000Z',
      expiresAt: '2099-01-02T00:00:00.000Z',
      approvedAt: '2026-01-01T00:01:00.000Z',
      capabilityRequests: [request, networkRequest],
    }
    const grants = mintCapabilityGrantBundle({
      approval,
      capabilityRequests: approval.capabilityRequests ?? [],
    }).map((grant, index) => (index === 0 ? { ...grant, usesRemaining: 0 } : grant))
    const record = { ...approval, grants, grant: grants[0] }

    const consumed = consumeApprovedRecordGrantBundle(record)
    expect(consumed.consumed).toBe(false)
    expect(consumed.approval).toBe(record)
  })
})
