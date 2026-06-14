import { describe, expect, it } from 'vitest'
import { filterAuditRecords } from '../../core/audit-query.js'
import type { AuditRecord } from '../../core/audit-types.js'

describe('audit schema v2', () => {
  const sample: AuditRecord = {
    timestamp: '2026-06-12T00:00:00.000Z',
    event: 'beforeShellExecution',
    kind: 'shell',
    verdict: 'deny_pending_approval',
    reason: 'high_stakes_path',
    schemaVersion: 2,
    location: 'repo_local',
    opacity: 'transparent',
    effect: 'local_mutation',
    confidence: 'deterministic',
    would: 'ask',
    by: 'v2',
    fingerprint: 'abc',
    summary: 'rm -rf .git',
  }

  it('filters by v2 location axis', () => {
    const filtered = filterAuditRecords([sample], { location: 'repo_local' })
    expect(filtered).toHaveLength(1)
  })

  it('filters by v2 opacity axis', () => {
    const filtered = filterAuditRecords([sample], { opacity: 'transparent' })
    expect(filtered).toHaveLength(1)
    expect(filterAuditRecords([sample], { opacity: 'opaque' })).toHaveLength(0)
  })
})
