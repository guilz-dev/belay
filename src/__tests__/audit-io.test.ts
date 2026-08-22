import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'
import { bucketGateEventsByDay, computeRepeatedFingerprintAsks } from '../core/audit-analysis.js'
import {
  appendAuditRecord,
  approvalCorrelationId,
  isValidAuditFingerprint,
  isValidAuditTimestamp,
  parseAuditNdjsonLine,
  serializeAuditRecordV3,
} from '../core/audit-io.js'
import { buildApprovalRoundTrips, filterAuditRecords, toAuditRecord } from '../core/audit-query.js'
import { DEFAULT_REDACTION_V3 } from '../core/config.js'

const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

describe('serializeAuditRecordV3', () => {
  const scrubOptions = DEFAULT_REDACTION_V3

  it('preserves ISO timestamp and 64-hex fingerprints through scrub', () => {
    const timestamp = '2026-08-22T05:00:00.000Z'
    const fingerprint = createHash('sha256').update('shell:test').digest('hex')
    const serialized = serializeAuditRecordV3(
      {
        timestamp,
        event: 'beforeShellExecution',
        fingerprint,
        commandFingerprint: fingerprint,
        summary: `Bearer ${'a'.repeat(48)}`,
        configFingerprint: fingerprint,
      },
      scrubOptions,
    )

    expect(serialized.timestamp).toBe(timestamp)
    expect(isValidAuditTimestamp(String(serialized.timestamp))).toBe(true)
    expect(serialized.fingerprint).toBe(fingerprint)
    expect(serialized.commandFingerprint).toBe(fingerprint)
    expect(serialized.configFingerprint).toBe(fingerprint)
    expect(String(serialized.summary)).not.toContain('a'.repeat(48))
  })

  it('masks raw approval IDs and stores approvalCorrelationId', () => {
    const approvalId = 'belay_deadbeef12345678'
    const serialized = serializeAuditRecordV3(
      {
        timestamp: '2026-08-22T05:00:00.000Z',
        approvalId,
        summary: approvalId,
      },
      scrubOptions,
    )

    expect(serialized.approvalId).toBeUndefined()
    expect(serialized.approvalCorrelationId).toBe(approvalCorrelationId(approvalId))
    expect(JSON.stringify(serialized)).not.toContain(approvalId)
    expect(JSON.stringify(serialized)).toContain('<approval-id>')
  })

  it('rejects malformed hash fields and scrubs them', () => {
    const serialized = serializeAuditRecordV3(
      {
        timestamp: '2026-08-22T05:00:00.000Z',
        fingerprint: 'not-a-valid-hash',
        effectIRHash: 'also-invalid',
        summary: 'ok',
      },
      scrubOptions,
    )

    expect(serialized.fingerprint).toBeUndefined()
    expect(serialized.effectIRHash).toBeUndefined()
  })

  it('supports reader filters and daily buckets after disk round-trip', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'belay-audit-io-'))
    tempDirs.push(tempDir)
    const auditPath = path.join(tempDir, 'audit.ndjson')
    const fp1 = createHash('sha256').update('one').digest('hex')
    const fp2 = createHash('sha256').update('two').digest('hex')

    await appendAuditRecord(
      auditPath,
      {
        timestamp: '2026-08-22T10:00:00.000Z',
        event: 'beforeShellExecution',
        kind: 'shell',
        verdict: 'deny_pending_approval',
        wouldBlock: true,
        fingerprint: fp1,
        summary: 'first',
      },
      scrubOptions,
    )
    await appendAuditRecord(
      auditPath,
      {
        timestamp: '2026-08-22T11:00:00.000Z',
        event: 'beforeShellExecution',
        kind: 'shell',
        verdict: 'deny_pending_approval',
        wouldBlock: true,
        fingerprint: fp2,
        summary: 'second',
      },
      scrubOptions,
    )

    const raw = await readFile(auditPath, 'utf8')
    const records = raw
      .trim()
      .split('\n')
      .map((line) => toAuditRecord(parseAuditNdjsonLine(line) as Record<string, unknown>))

    expect(filterAuditRecords(records, { since: '2026-08-22T10:30:00.000Z' })).toHaveLength(1)
    expect(bucketGateEventsByDay(records)).toEqual({ '2026-08-22': 2 })
    expect(computeRepeatedFingerprintAsks(records)).toHaveLength(0)
  })

  it('joins ask → approval → approved-once via approvalCorrelationId', () => {
    const approvalId = 'belay_cafebabef00d1234'
    const correlationId = approvalCorrelationId(approvalId)
    const fingerprint = createHash('sha256').update('cmd').digest('hex')
    const records = [
      serializeAuditRecordV3(
        {
          timestamp: '2026-08-22T10:00:00.000Z',
          event: 'beforeShellExecution',
          kind: 'shell',
          verdict: 'deny_pending_approval',
          wouldBlock: true,
          fingerprint,
          approvalId,
          summary: 'rm x',
        },
        scrubOptions,
      ),
      serializeAuditRecordV3(
        {
          timestamp: '2026-08-22T10:00:05.000Z',
          event: 'approval',
          reason: 'approval_recorded',
          approvalId,
        },
        scrubOptions,
      ),
      serializeAuditRecordV3(
        {
          timestamp: '2026-08-22T10:00:10.000Z',
          event: 'beforeShellExecution',
          kind: 'shell',
          reason: 'approved_once',
          permission: 'allow',
          fingerprint,
          summary: 'rm x',
        },
        scrubOptions,
      ),
    ].map((record) => toAuditRecord(record))

    const trips = buildApprovalRoundTrips(records)
    expect(trips).toHaveLength(1)
    expect(trips[0]?.approvalTimestamp).toBe('2026-08-22T10:00:05.000Z')
    expect(trips[0]?.executeTimestamp).toBe('2026-08-22T10:00:10.000Z')
    expect(trips[0]?.approvalCorrelationId).toBe(correlationId)
  })
})

describe('audit correlation helpers', () => {
  it('rejects scrub placeholders as valid fingerprints or timestamps', () => {
    expect(isValidAuditFingerprint('<high-entropy>')).toBe(false)
    expect(isValidAuditTimestamp('<timestamp>')).toBe(false)
  })
})
