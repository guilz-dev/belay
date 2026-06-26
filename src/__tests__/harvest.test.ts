import { describe, expect, it } from 'vitest'

import { harvestReportFromNdjson } from '../commands/harvest.js'
import { toAuditRecord } from '../core/audit-query.js'
import {
  applyHarvestReview,
  buildHarvestReport,
  extractAvailabilityQueue,
  extractHarvestCandidates,
  filterRecordsForHarvest,
} from '../core/harvest.js'

function shellDeny(params: Record<string, unknown>) {
  return toAuditRecord({
    event: 'beforeShellExecution',
    kind: 'shell',
    verdict: 'deny_pending_approval',
    wouldBlock: true,
    ...params,
  })
}

describe('harvest', () => {
  it('separates availability-caused asks from benign candidates', () => {
    const records = [
      shellDeny({
        fingerprint: 'fp-avail',
        summary: 'git status',
        reason: 'unknown_local_effect',
        judgeFallbackReason: 'eval_timeout',
      }),
      shellDeny({
        fingerprint: 'fp-classifier',
        summary: 'git status',
        reason: 'unknown_local_effect',
      }),
      shellDeny({
        fingerprint: 'fp-classifier',
        summary: 'git status',
        reason: 'unknown_local_effect',
      }),
    ]

    const report = buildHarvestReport(records)
    expect(report.availabilityQueue).toHaveLength(1)
    expect(report.availabilityQueue[0]?.availabilitySignal).toBe('judge_timeout')
    expect(report.candidates.some((entry) => entry.fingerprint === 'fp-avail')).toBe(false)
    expect(report.candidates.some((entry) => entry.fingerprint === 'fp-classifier')).toBe(true)
  })

  it('keeps paired deny rows when --since filters only the approval event', () => {
    const records = [
      shellDeny({
        timestamp: '2026-01-01T00:00:00.000Z',
        fingerprint: 'fp-since-pair',
        summary: 'pnpm test',
        reason: 'unknown_local_effect',
        approvalId: 'belay_since_pair',
      }),
      toAuditRecord({
        event: 'approval',
        reason: 'approval_recorded',
        approvalId: 'belay_since_pair',
        timestamp: '2026-01-02T00:00:00.000Z',
      }),
    ]

    const report = buildHarvestReport(
      filterRecordsForHarvest(records, { since: '2026-01-02T00:00:00.000Z' }),
    )
    expect(report.candidates).toHaveLength(1)
    expect(report.candidates[0]?.sources).toContain('deny_then_approve')
  })

  it('harvest list filter keeps approval events for deny-then-approve detection', () => {
    const records = [
      shellDeny({
        timestamp: '2026-01-01T00:00:00.000Z',
        fingerprint: 'fp-list-path',
        summary: 'pnpm test',
        reason: 'unknown_local_effect',
        approvalId: 'belay_list123',
      }),
      toAuditRecord({
        event: 'approval',
        reason: 'approval_recorded',
        approvalId: 'belay_list123',
        timestamp: '2026-01-01T00:01:00.000Z',
      }),
    ]

    const report = buildHarvestReport(filterRecordsForHarvest(records))
    expect(report.candidates).toHaveLength(1)
    expect(report.candidates[0]?.sources).toContain('deny_then_approve')
  })

  it('includes deny-then-approve shell round trips as candidates only', () => {
    const records = [
      shellDeny({
        timestamp: '2026-01-01T00:00:00.000Z',
        fingerprint: 'fp-trip',
        summary: 'pnpm test',
        reason: 'unknown_local_effect',
        approvalId: 'belay_abc123',
      }),
      toAuditRecord({
        event: 'approval',
        reason: 'approval_recorded',
        approvalId: 'belay_abc123',
        timestamp: '2026-01-01T00:01:00.000Z',
      }),
    ]

    const candidates = extractHarvestCandidates(records)
    expect(candidates).toHaveLength(1)
    expect(candidates[0]?.sources).toContain('deny_then_approve')
    expect(candidates[0]?.approvedAfterDeny).toBe(true)
  })

  it('tags read-style shell commands as static-signal candidates', () => {
    const records = [
      shellDeny({
        fingerprint: 'fp-read',
        summary: 'git diff --stat',
        reason: 'unknown_local_effect',
      }),
    ]

    const candidates = extractHarvestCandidates(records)
    expect(candidates[0]?.sources).toContain('read_style_signal')
  })

  it('does not mix tool audit events into shell harvest scope', () => {
    const records = [
      toAuditRecord({
        event: 'preToolUse',
        kind: 'tool',
        verdict: 'deny_pending_approval',
        wouldBlock: true,
        fingerprint: 'tool-fp',
        summary: 'read_file',
        reason: 'unknown_local_effect',
      }),
      shellDeny({
        fingerprint: 'shell-fp',
        summary: 'ls -la',
        reason: 'read_only',
      }),
    ]

    expect(extractHarvestCandidates(records).every((entry) => entry.kind === 'shell')).toBe(true)
    expect(extractAvailabilityQueue(records)).toHaveLength(0)
  })

  it('persists reviewed accepted-benign and provably-benign outcomes', () => {
    const base = [
      {
        kind: 'shell' as const,
        category: 'provably-benign' as const,
        command: 'git status',
        verdict: 'allow' as const,
      },
    ]

    const accepted = applyHarvestReview(base, {
      command: 'touch notes.txt',
      outcome: 'accepted-benign',
    })
    expect(accepted.applied).toBe(true)
    expect(accepted.ok).toBe(true)
    expect(accepted.cases.at(-1)).toMatchObject({
      category: 'accepted-benign',
      verdict: 'allow_flagged',
    })
    expect(accepted.cases.at(-1)).not.toHaveProperty('reason')

    const promoted = applyHarvestReview(accepted.cases, {
      command: 'rg TODO',
      outcome: 'provably-benign',
      reason: 'read_only',
    })
    expect(promoted.applied).toBe(true)
    expect(promoted.ok).toBe(true)
    expect(promoted.message).toContain('pnpm corpus')
    expect(promoted.message).toContain('pnpm build')
    expect(promoted.cases.at(-1)).toMatchObject({
      category: 'provably-benign',
      verdict: 'allow',
      reason: 'read_only',
    })

    const rejected = applyHarvestReview(promoted.cases, {
      command: 'make deploy',
      outcome: 'reject',
    })
    expect(rejected.applied).toBe(false)
    expect(rejected.ok).toBe(true)
    expect(rejected.message).toContain('Reviewed and rejected')
    expect(rejected.cases).toHaveLength(promoted.cases.length)
  })

  it('parses ndjson via harvest command helper', () => {
    const raw = `${JSON.stringify({
      event: 'beforeShellExecution',
      kind: 'shell',
      verdict: 'deny_pending_approval',
      wouldBlock: true,
      fingerprint: 'fp',
      summary: 'git status',
      reason: 'missing_trusted_cwd',
    })}\n`

    const report = harvestReportFromNdjson(raw)
    expect(report.scope).toBe('shell')
    expect(report.availabilityQueue).toHaveLength(1)
    expect(report.candidates).toHaveLength(0)
  })
})
