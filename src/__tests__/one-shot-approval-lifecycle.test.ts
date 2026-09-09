import { describe, expect, it } from 'vitest'

import { mintCapabilityGrantBundle } from '../core/capability/approval-v3.js'
import type { CapabilityRequestV1 } from '../core/capability/request.js'
import {
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
})
