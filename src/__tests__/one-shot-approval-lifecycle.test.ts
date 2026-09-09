import { describe, expect, it } from 'vitest'

import { mintCapabilityGrantBundle } from '../core/capability/approval-v3.js'
import type { CapabilityRequestV1 } from '../core/capability/request.js'
import {
  claimApprovedForGateTransition,
  claimApprovedForReplayTransition,
  discardApprovedTransition,
  ensurePendingApprovalTransition,
  recordApprovalTransition,
} from '../core/one-shot-approval-lifecycle.js'
import type { ApprovalRecord, ApprovalStateFile } from '../core/types.js'

const NOW = Date.parse('2026-09-09T00:00:00.000Z')
const APPROVED_AT = '2026-09-09T00:00:01.000Z'

const capabilityRequestFixture: CapabilityRequestV1 = {
  version: 1,
  principal: { repoRoot: '/repo', sessionHash: 'session' },
  action: 'fs.write',
  resource: { kind: 'path', path: '/repo/README.md' },
  context: {
    hookKind: 'shell',
    cwd: '/repo',
    inputFingerprint: 'fp',
    analysisBasis: ['effect-plan'],
  },
  evidence: { level: 'certain', signals: ['repo_local_write'] },
}

function approvalRecord(overrides: Partial<ApprovalRecord> = {}): ApprovalRecord {
  return {
    approvalId: 'belay_default',
    kind: 'shell',
    fingerprint: 'fp',
    repoRoot: '/repo',
    reason: 'unknown_local_effect',
    summary: 'git push',
    createdAt: '2026-09-08T00:00:00.000Z',
    expiresAt: '2026-09-11T00:00:00.000Z',
    ...overrides,
  }
}

function approvedRecordWithExactBundle(overrides: Partial<ApprovalRecord> = {}): ApprovalRecord {
  const approval = approvalRecord({
    approvalId: 'belay_exact',
    approvedAt: APPROVED_AT,
    capabilityRequests: [capabilityRequestFixture],
    ...overrides,
  })
  const grants = mintCapabilityGrantBundle({
    approval,
    capabilityRequests: approval.capabilityRequests ?? [],
  })
  return {
    ...approval,
    grants,
    grant: grants[0],
    grantBundleVersion: 1,
  }
}

describe('one-shot approval lifecycle', () => {
  it('reuses the existing pending approval for the same action identity', () => {
    const existing = approvalRecord({ approvalId: 'belay_existing' })
    const candidate = approvalRecord({ approvalId: 'belay_candidate' })
    const state: ApprovalStateFile = { version: 3, revision: 4, approvals: [existing] }

    const outcome = ensurePendingApprovalTransition({ state, candidate, nowMs: NOW })

    expect(outcome.created).toBe(false)
    expect(outcome.approval.approvalId).toBe('belay_existing')
    expect(outcome.state).toEqual(state)
    expect(outcome.state).not.toBe(state)
  })

  it('adds a new pending approval without mutating the loaded state', () => {
    const candidate = approvalRecord({ approvalId: 'belay_candidate' })
    const state: ApprovalStateFile = { version: 3, revision: 2, approvals: [] }

    const outcome = ensurePendingApprovalTransition({ state, candidate, nowMs: NOW })

    expect(outcome).toEqual({
      state: { version: 3, revision: 2, approvals: [candidate] },
      approval: candidate,
      created: true,
    })
    expect(state.approvals).toEqual([])
  })

  it('removes expired pending approvals before matching a candidate', () => {
    const expired = approvalRecord({
      approvalId: 'belay_expired',
      expiresAt: '2026-09-08T23:59:59.000Z',
    })
    const candidate = approvalRecord({ approvalId: 'belay_candidate' })

    const outcome = ensurePendingApprovalTransition({
      state: { version: 3, approvals: [expired] },
      candidate,
      nowMs: NOW,
    })

    expect(outcome.created).toBe(true)
    expect(outcome.state.approvals.map((entry) => entry.approvalId)).toEqual(['belay_candidate'])
  })

  it('moves one matching pending approval into approved state with an exact grant bundle', () => {
    const pendingRecord = approvalRecord({
      approvalId: 'belay_pending',
      capabilityRequests: [capabilityRequestFixture],
    })
    const pending: ApprovalStateFile = { version: 3, approvals: [pendingRecord] }
    const approved: ApprovalStateFile = { version: 3, approvals: [] }

    const outcome = recordApprovalTransition({
      pending,
      approved,
      approvalId: 'belay_pending',
      approvedAt: APPROVED_AT,
      nowMs: NOW,
    })

    expect(outcome?.pending.approvals).toEqual([])
    expect(outcome?.approved.approvals).toHaveLength(1)
    expect(outcome?.approval.approvedAt).toBe(APPROVED_AT)
    expect(outcome?.approval.grantBundleVersion).toBe(1)
    expect(outcome?.approval.grants).toHaveLength(1)
    expect(pending.approvals).toEqual([pendingRecord])
    expect(approved.approvals).toEqual([])
  })

  it('removes only the first matching pending record when malformed duplicates exist', () => {
    const first = approvalRecord({ approvalId: 'belay_duplicate', summary: 'first' })
    const duplicate = approvalRecord({ approvalId: 'belay_duplicate', summary: 'second' })

    const outcome = recordApprovalTransition({
      pending: { version: 3, approvals: [first, duplicate] },
      approved: { version: 3, approvals: [] },
      approvalId: 'belay_duplicate',
      approvedAt: APPROVED_AT,
      nowMs: NOW,
    })

    expect(outcome?.pending.approvals).toEqual([duplicate])
    expect(outcome?.approval.summary).toBe('first')
  })

  it('returns the existing approved record when recording is retried', () => {
    const existing = approvalRecord({
      approvalId: 'belay_existing',
      approvedAt: APPROVED_AT,
    })

    const outcome = recordApprovalTransition({
      pending: { version: 3, approvals: [] },
      approved: { version: 3, approvals: [existing] },
      approvalId: 'belay_existing',
      approvedAt: '2026-09-09T00:00:02.000Z',
      nowMs: NOW,
    })

    expect(outcome?.approval).toEqual(existing)
    expect(outcome?.approved.approvals).toEqual([existing])
  })

  it('rejects an approved record whose identity conflicts with the pending approval', () => {
    const pending = approvalRecord({ approvalId: 'belay_conflict', fingerprint: 'pending-fp' })
    const approved = approvalRecord({
      approvalId: 'belay_conflict',
      fingerprint: 'approved-fp',
      approvedAt: APPROVED_AT,
    })

    expect(
      recordApprovalTransition({
        pending: { version: 3, approvals: [pending] },
        approved: { version: 3, approvals: [approved] },
        approvalId: 'belay_conflict',
        approvedAt: APPROVED_AT,
        nowMs: NOW,
      }),
    ).toBeNull()
  })

  it('returns null when no active pending or approved record matches', () => {
    const expired = approvalRecord({
      approvalId: 'belay_expired',
      expiresAt: '2026-09-08T23:59:59.000Z',
    })

    expect(
      recordApprovalTransition({
        pending: { version: 3, approvals: [expired] },
        approved: { version: 3, approvals: [] },
        approvalId: 'belay_expired',
        approvedAt: APPROVED_AT,
        nowMs: NOW,
      }),
    ).toBeNull()
  })

  it('preserves an existing exact bundle when recording is retried', () => {
    const base = approvalRecord({
      approvalId: 'belay_bundle',
      approvedAt: APPROVED_AT,
      capabilityRequests: [capabilityRequestFixture],
    })
    const grants = mintCapabilityGrantBundle({
      approval: base,
      capabilityRequests: [capabilityRequestFixture],
    })
    const existing: ApprovalRecord = {
      ...base,
      grants,
      grant: grants[0],
      grantBundleVersion: 1,
    }

    const outcome = recordApprovalTransition({
      pending: { version: 3, approvals: [] },
      approved: { version: 3, approvals: [existing] },
      approvalId: 'belay_bundle',
      approvedAt: '2026-09-09T00:00:02.000Z',
      nowMs: NOW,
    })

    expect(outcome?.approval).toEqual(existing)
  })

  it('consumes an exact bundle once and establishes the supplied execution lease', () => {
    const approved = approvedRecordWithExactBundle()

    const outcome = claimApprovedForGateTransition({
      state: { version: 3, approvals: [approved] },
      kind: 'shell',
      fingerprint: approved.fingerprint,
      repoRoot: approved.repoRoot,
      requests: approved.capabilityRequests ?? [],
      executionLeaseExpiresAt: '2026-09-09T00:00:30.000Z',
      nowMs: NOW,
    })

    expect(outcome.result?.status).toBe('consumed')
    expect(outcome.result?.status === 'consumed' && outcome.result.firstExecution).toBe(true)
    expect(outcome.state.approvals[0]?.executionLeaseExpiresAt).toBe('2026-09-09T00:00:30.000Z')
    expect(outcome.state.approvals[0]?.grants?.[0]?.usesRemaining).toBe(0)
    expect(approved.grants?.[0]?.usesRemaining).toBe(1)
  })

  it('reuses an active execution lease without consuming its exact bundle twice', () => {
    const first = approvedRecordWithExactBundle()
    const grants = first.grants?.map((grant) => ({ ...grant, usesRemaining: 0 })) ?? []
    const leased: ApprovalRecord = {
      ...first,
      grants,
      grant: grants[0],
      executionLeaseExpiresAt: '2026-09-09T00:00:30.000Z',
    }

    const outcome = claimApprovedForGateTransition({
      state: { version: 3, approvals: [leased] },
      kind: 'shell',
      fingerprint: leased.fingerprint,
      repoRoot: leased.repoRoot,
      requests: leased.capabilityRequests ?? [],
      executionLeaseExpiresAt: '2026-09-09T00:01:00.000Z',
      nowMs: NOW,
    })

    expect(outcome.result).toEqual({
      status: 'consumed',
      approval: leased,
      firstExecution: false,
    })
    expect(outcome.state.approvals[0]?.executionLeaseExpiresAt).toBe('2026-09-09T00:00:30.000Z')
    expect(outcome.state.approvals[0]?.grants?.[0]?.usesRemaining).toBe(0)
  })

  it('removes an exhausted approval that has no active execution lease', () => {
    const approved = approvedRecordWithExactBundle()
    const grants = approved.grants?.map((grant) => ({ ...grant, usesRemaining: 0 })) ?? []
    const exhausted: ApprovalRecord = { ...approved, grants, grant: grants[0] }

    const outcome = claimApprovedForGateTransition({
      state: { version: 3, approvals: [exhausted] },
      kind: 'shell',
      fingerprint: exhausted.fingerprint,
      repoRoot: exhausted.repoRoot,
      requests: exhausted.capabilityRequests ?? [],
      executionLeaseExpiresAt: '2026-09-09T00:00:30.000Z',
      nowMs: NOW,
    })

    expect(outcome.result).toBeNull()
    expect(outcome.state.approvals).toEqual([])
  })

  it('removes a marked exact bundle that does not match the current requests', () => {
    const approved = approvedRecordWithExactBundle()
    const differentRequest: CapabilityRequestV1 = {
      ...capabilityRequestFixture,
      action: 'fs.read',
    }

    const outcome = claimApprovedForGateTransition({
      state: { version: 3, approvals: [approved] },
      kind: 'shell',
      fingerprint: approved.fingerprint,
      repoRoot: approved.repoRoot,
      requests: [differentRequest],
      executionLeaseExpiresAt: '2026-09-09T00:00:30.000Z',
      nowMs: NOW,
    })

    expect(outcome.result).toMatchObject({
      status: 'invalid_bundle',
      reason: 'grant_mismatch',
    })
    expect(outcome.state.approvals).toEqual([])
  })

  it('returns no gate claim when action identity does not match', () => {
    const approved = approvedRecordWithExactBundle()

    const outcome = claimApprovedForGateTransition({
      state: { version: 3, approvals: [approved] },
      kind: 'shell',
      fingerprint: 'different-fingerprint',
      repoRoot: approved.repoRoot,
      requests: approved.capabilityRequests ?? [],
      executionLeaseExpiresAt: '2026-09-09T00:00:30.000Z',
      nowMs: NOW,
    })

    expect(outcome.result).toBeNull()
    expect(outcome.state.approvals).toEqual([approved])
  })

  it('removes an approved record before replay', () => {
    const approved = approvalRecord({
      approvalId: 'belay_replay',
      approvedAt: APPROVED_AT,
    })

    const outcome = claimApprovedForReplayTransition({
      state: { version: 3, approvals: [approved] },
      approvalId: 'belay_replay',
      nowMs: NOW,
    })

    expect(outcome.approval?.approvalId).toBe('belay_replay')
    expect(outcome.state.approvals).toEqual([])
  })

  it('does not claim an expired approved record for replay', () => {
    const expired = approvalRecord({
      approvalId: 'belay_expired',
      approvedAt: APPROVED_AT,
      expiresAt: '2026-09-08T23:59:59.000Z',
    })

    const outcome = claimApprovedForReplayTransition({
      state: { version: 3, approvals: [expired] },
      approvalId: 'belay_expired',
      nowMs: NOW,
    })

    expect(outcome.approval).toBeNull()
    expect(outcome.state.approvals).toEqual([])
  })

  it('discards only the rejected approved record', () => {
    const rejected = approvalRecord({
      approvalId: 'belay_rejected',
      approvedAt: APPROVED_AT,
    })
    const retained = approvalRecord({
      approvalId: 'belay_retained',
      approvedAt: APPROVED_AT,
    })

    const outcome = discardApprovedTransition({
      state: { version: 3, approvals: [rejected, retained] },
      approvalId: 'belay_rejected',
      nowMs: NOW,
    })

    expect(outcome.discarded).toBe(true)
    expect(outcome.state.approvals.map((entry) => entry.approvalId)).toEqual(['belay_retained'])
  })

  it('reports no discard when an approved record is missing', () => {
    const retained = approvalRecord({
      approvalId: 'belay_retained',
      approvedAt: APPROVED_AT,
    })

    const outcome = discardApprovedTransition({
      state: { version: 3, approvals: [retained] },
      approvalId: 'belay_missing',
      nowMs: NOW,
    })

    expect(outcome.discarded).toBe(false)
    expect(outcome.state.approvals).toEqual([retained])
  })
})
