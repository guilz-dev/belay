import { describe, expect, it } from 'vitest'

import { approvalCommandMatch, compactApprovals, mergeApprovalStates } from '../core/approval.js'

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

describe('approvalCommandMatch', () => {
  it('matches a one-line approval prompt', () => {
    expect(approvalCommandMatch('/belay-approve belay_abc123', '/belay-approve')).toBe(
      'belay_abc123',
    )
  })

  it('matches when approval command is first line and message has extra text', () => {
    const prompt = ['/belay-approve belay_first_line', 'please continue'].join('\n')
    expect(approvalCommandMatch(prompt, '/belay-approve')).toBe('belay_first_line')
  })

  it('does not match when first non-empty line is not an approval command', () => {
    const prompt = ['please check first', '/belay-approve belay_later_line'].join('\n')
    expect(approvalCommandMatch(prompt, '/belay-approve')).toBeNull()
  })
})

describe('compactApprovals', () => {
  it('drops approved entries after their execution lease expires', () => {
    const compacted = compactApprovals({
      version: 2,
      approvals: [
        {
          approvalId: 'belay_lease_expired',
          kind: 'shell',
          fingerprint: 'fp',
          repoRoot: '/repo',
          reason: 'unknown_local_effect',
          summary: 'git push',
          createdAt: '2026-01-01T00:00:00.000Z',
          expiresAt: '2099-01-01T00:00:00.000Z',
          approvedAt: '2026-01-01T00:00:00.000Z',
          executionLeaseExpiresAt: '2026-01-01T00:00:01.000Z',
        },
      ],
    })

    expect(compacted.approvals).toHaveLength(0)
  })
})
