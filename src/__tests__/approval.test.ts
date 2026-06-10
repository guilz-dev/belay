import { describe, expect, it } from 'vitest'

import { mergeApprovalStates } from '../core/approval.js'

describe('mergeApprovalStates', () => {
  it('keeps target approvals and adds non-duplicate source approvals', () => {
    const merged = mergeApprovalStates(
      {
        version: 1,
        approvals: [
          {
            approvalId: 'belay_keep',
            kind: 'shell',
            fingerprint: 'target',
            repoRoot: '/a',
            reason: 'external_effect',
            summary: 'git push',
            createdAt: '2026-01-01T00:00:00.000Z',
            expiresAt: '2099-01-01T00:00:00.000Z',
          },
        ],
      },
      {
        version: 1,
        approvals: [
          {
            approvalId: 'belay_keep',
            kind: 'shell',
            fingerprint: 'source',
            repoRoot: '/b',
            reason: 'external_effect',
            summary: 'ignored duplicate',
            createdAt: '2026-01-01T00:00:00.000Z',
            expiresAt: '2099-01-01T00:00:00.000Z',
          },
          {
            approvalId: 'belay_add',
            kind: 'tool',
            fingerprint: 'new',
            repoRoot: '/b',
            reason: 'sensitive_file_mutation',
            summary: '.env',
            createdAt: '2026-01-01T00:00:00.000Z',
            expiresAt: '2099-01-01T00:00:00.000Z',
          },
        ],
      },
    )

    expect(merged.approvals).toHaveLength(2)
    expect(merged.approvals.find((approval) => approval.approvalId === 'belay_keep')?.summary).toBe(
      'git push',
    )
    expect(merged.approvals.find((approval) => approval.approvalId === 'belay_add')?.kind).toBe(
      'tool',
    )
  })
})
