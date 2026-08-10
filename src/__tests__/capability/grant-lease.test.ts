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
  validateAndConsumeGrantBundle,
  validateGrantBundleForLeaseReuse,
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

  it('atomically consumes an exact marked bundle independent of grant order', () => {
    const approval: ApprovalRecord = {
      approvalId: 'exact-reordered',
      kind: 'shell',
      fingerprint: 'fp-exact',
      repoRoot: '/repo',
      reason: 'external_effect',
      summary: 'npx prettier',
      createdAt: '2026-01-01T00:00:00.000Z',
      expiresAt: '2099-01-02T00:00:00.000Z',
      approvedAt: '2026-01-01T00:01:00.000Z',
      capabilityRequests: [request, networkRequest],
      grantBundleVersion: 1,
    }
    const grants = mintCapabilityGrantBundle({
      approval,
      capabilityRequests: approval.capabilityRequests ?? [],
    }).reverse()
    const record = { ...approval, grants, grant: grants[0] }

    const consumed = validateAndConsumeGrantBundle(record, [request, networkRequest])

    expect(consumed.ok).toBe(true)
    if (!consumed.ok) {
      throw new Error(`expected exact bundle success, got ${consumed.reason}`)
    }
    expect(consumed.approval.grants?.every((grant) => grant.usesRemaining === 0)).toBe(true)
  })

  it('matches the same exact bundle after JSON persistence removes undefined fields', () => {
    const currentRequest: CapabilityRequestV1 = {
      ...request,
      principal: { ...request.principal, adapter: undefined },
    }
    const approval: ApprovalRecord = {
      approvalId: 'exact-persisted',
      kind: 'shell',
      fingerprint: 'fp-exact-persisted',
      repoRoot: '/repo',
      reason: 'external_effect',
      summary: 'git push origin main',
      createdAt: '2026-01-01T00:00:00.000Z',
      expiresAt: '2099-01-02T00:00:00.000Z',
      approvedAt: '2026-01-01T00:01:00.000Z',
      capabilityRequests: [currentRequest],
      grantBundleVersion: 1,
    }
    const grants = mintCapabilityGrantBundle({
      approval,
      capabilityRequests: [currentRequest],
    })
    const persisted = JSON.parse(
      JSON.stringify({ ...approval, grants, grant: grants[0] }),
    ) as ApprovalRecord

    expect(validateAndConsumeGrantBundle(persisted, [currentRequest]).ok).toBe(true)
  })

  it('revalidates an already-consumed exact bundle during lease reuse', () => {
    const approval: ApprovalRecord = {
      approvalId: 'exact-lease',
      kind: 'shell',
      fingerprint: 'fp-exact-lease',
      repoRoot: '/repo',
      reason: 'external_effect',
      summary: 'write',
      createdAt: '2026-01-01T00:00:00.000Z',
      expiresAt: '2099-01-02T00:00:00.000Z',
      approvedAt: '2026-01-01T00:01:00.000Z',
      capabilityRequests: [request],
      grantBundleVersion: 1,
    }
    const grants = mintCapabilityGrantBundle({ approval, capabilityRequests: [request] }).map(
      (grant) => ({ ...grant, usesRemaining: 0 }),
    )
    const record = { ...approval, grants, grant: grants[0] }

    expect(validateGrantBundleForLeaseReuse(record, [request]).ok).toBe(true)
    expect(validateGrantBundleForLeaseReuse({ ...record, grants: [], grant: undefined }, [request]))
      .toMatchObject({ ok: false, reason: 'cardinality_mismatch' })
  })

  it.each([
    {
      name: 'extra',
      requests: [request],
      grantsFor: [request, networkRequest],
      mutate: (grants: NonNullable<ApprovalRecord['grants']>) => grants,
      reason: 'cardinality_mismatch',
    },
    {
      name: 'unrelated',
      requests: [request, networkRequest],
      grantsFor: [request, networkRequest],
      mutate: (grants: NonNullable<ApprovalRecord['grants']>) => [
        grants[0]!,
        { ...grants[1]!, resource: { kind: 'network' as const, host: 'evil.example' } },
      ],
      reason: 'grant_mismatch',
    },
    {
      name: 'broad',
      requests: [request, networkRequest],
      grantsFor: [request, networkRequest],
      mutate: (grants: NonNullable<ApprovalRecord['grants']>) => [
        grants[0]!,
        { ...grants[1]!, resource: { kind: 'network' as const, host: '*' } },
      ],
      reason: 'grant_scope_too_broad',
    },
  ])('rejects a $name grant bundle without consuming any lease', (fixture) => {
    const approval: ApprovalRecord = {
      approvalId: `exact-${fixture.name}`,
      kind: 'shell',
      fingerprint: 'fp-exact-invalid',
      repoRoot: '/repo',
      reason: 'external_effect',
      summary: 'npx prettier',
      createdAt: '2026-01-01T00:00:00.000Z',
      expiresAt: '2099-01-02T00:00:00.000Z',
      approvedAt: '2026-01-01T00:01:00.000Z',
      capabilityRequests: fixture.requests,
      grantBundleVersion: 1,
    }
    const minted = mintCapabilityGrantBundle({
      approval,
      capabilityRequests: fixture.grantsFor,
    })
    const grants = fixture.mutate(minted)
    const record = { ...approval, grants, grant: grants[0] }

    const consumed = validateAndConsumeGrantBundle(record, fixture.requests)

    expect(consumed).toMatchObject({ ok: false, reason: fixture.reason })
    expect(record.grants?.every((grant) => grant.usesRemaining === 1)).toBe(true)
  })

  it('does not interpret unmarked version-3 records as exact bundles', () => {
    const approval = approvedWithGrant()

    expect(validateAndConsumeGrantBundle(approval, [request])).toEqual({
      ok: false,
      reason: 'legacy_record',
    })
  })
})
