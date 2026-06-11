import { describe, expect, it } from 'vitest'

import { detectBypassAttempts, detectNoisyRules } from '../core/audit-analysis.js'
import {
  buildApprovalRoundTrips,
  filterAuditRecords,
  summarizeRoundTrips,
} from '../core/audit-query.js'

describe('audit query', () => {
  const records = [
    {
      timestamp: '2026-06-01T10:00:00.000Z',
      event: 'beforeShellExecution',
      kind: 'shell',
      verdict: 'deny_pending_approval',
      reason: 'unknown_local_effect',
      fingerprint: 'fp1',
      summary: 'make build',
      wouldBlock: true,
      approvalId: 'belay_abc',
    },
    {
      timestamp: '2026-06-01T10:01:00.000Z',
      event: 'approval',
      kind: 'approval',
      verdict: 'allow',
      reason: 'approval_recorded',
      approvalId: 'belay_abc',
      summary: '/belay-approve belay_abc',
    },
    {
      timestamp: '2026-06-01T10:02:00.000Z',
      event: 'beforeShellExecution',
      kind: 'shell',
      verdict: 'allow',
      reason: 'approved_once',
      fingerprint: 'fp1',
      summary: 'make build',
      permission: 'allow',
    },
    {
      timestamp: '2026-06-01T10:03:00.000Z',
      event: 'beforeShellExecution',
      kind: 'shell',
      verdict: 'allow',
      reason: 'read_only',
      fingerprint: 'fp2',
      summary: 'git status',
    },
  ]

  it('filters records by verdict', () => {
    const filtered = filterAuditRecords(records, { verdict: 'deny_pending_approval' })
    expect(filtered).toHaveLength(1)
    expect(filtered[0]?.summary).toBe('make build')
  })

  it('builds deny-approve-execute round trips', () => {
    const trips = buildApprovalRoundTrips(records)
    expect(trips).toHaveLength(1)
    expect(trips[0]?.approvalLatencyMs).toBe(60_000)
    expect(trips[0]?.executeTimestamp).toContain('10:02')
    expect(summarizeRoundTrips(trips)[0]).toContain('approved')
  })

  it('detects noisy rules with high approval rate', () => {
    const trips = buildApprovalRoundTrips(records)
    const noisy = detectNoisyRules(
      [
        ...records,
        {
          timestamp: '2026-06-01T11:00:00.000Z',
          event: 'beforeShellExecution',
          kind: 'shell',
          verdict: 'deny_pending_approval',
          reason: 'unknown_local_effect',
          fingerprint: 'fp3',
          summary: 'make test',
          wouldBlock: true,
          approvalId: 'belay_def',
        },
        {
          timestamp: '2026-06-01T11:01:00.000Z',
          event: 'approval',
          reason: 'approval_recorded',
          approvalId: 'belay_def',
        },
      ],
      trips,
      1,
    )
    expect(noisy.some((rule) => rule.reason === 'unknown_local_effect')).toBe(true)
  })

  it('detects bypass attempts after deny', () => {
    const attempts = detectBypassAttempts([
      {
        timestamp: '2026-06-01T10:00:00.000Z',
        event: 'beforeShellExecution',
        verdict: 'deny_pending_approval',
        fingerprint: 'fp-deny',
        summary: 'curl https://example.com',
        wouldBlock: true,
      },
      {
        timestamp: '2026-06-01T10:00:30.000Z',
        event: 'beforeShellExecution',
        verdict: 'allow',
        fingerprint: 'fp-try',
        summary: 'bash -c "curl https://example.com"',
      },
    ])
    expect(attempts.length).toBeGreaterThan(0)
    expect(attempts[0]?.signal).toBe('wrapper_pattern')
  })
})
