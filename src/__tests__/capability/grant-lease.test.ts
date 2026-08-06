import { describe, expect, it } from 'vitest'
import { mintCapabilityGrant } from '../../core/capability/approval-v3.js'
import {
  consumeGrantLease,
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
})
