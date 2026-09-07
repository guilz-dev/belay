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
  toolInvocationCorrelationId,
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

  it('preserves a one-way tool invocation correlation without storing the raw tool use ID', () => {
    const rawToolUseId = 'abc123'
    const serialized = serializeAuditRecordV3(
      {
        timestamp: '2026-08-22T05:00:00.000Z',
        tool_use_id: rawToolUseId,
        toolInvocationCorrelationId: toolInvocationCorrelationId(rawToolUseId),
        replayContext: { payload: { tool_use_id: rawToolUseId } },
      },
      scrubOptions,
    )

    expect(serialized.toolInvocationCorrelationId).toBe('6ca13d52ca70c883')
    expect(JSON.stringify(serialized)).not.toContain(rawToolUseId)
  })

  it('normalizes Cursor tool_use_id prefixes before correlation hashing', () => {
    const bareUuid = 'f5be1fa7-4c96-4568-817d-098e61fbf891'
    const prefixed = `tool_${bareUuid}`
    expect(toolInvocationCorrelationId(prefixed)).toBe(toolInvocationCorrelationId(bareUuid))
    expect(toolInvocationCorrelationId(bareUuid.toUpperCase())).toBe(
      toolInvocationCorrelationId(bareUuid),
    )
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

  it('removes source, prompt, patch, tool input, and tool output bodies from new gate records', () => {
    const markers = {
      source: 'task ten source body canary',
      prompt: 'task ten prompt body canary',
      patch: 'task ten patch body canary',
      input: 'task ten tool input body canary',
      output: 'task ten tool output body canary',
    }
    const payloadHash = createHash('sha256').update(markers.input).digest('hex')
    const serialized = serializeAuditRecordV3(
      {
        event: 'preToolUse',
        kind: 'tool',
        summary: markers.prompt,
        source: markers.source,
        prompt: markers.prompt,
        patch: markers.patch,
        input: markers.input,
        output: markers.output,
        tool_input: { contents: markers.input },
        tool_output: { text: markers.output },
        replayContext: {
          cwd: '/workspace/project',
          kind: 'tool',
          toolName: 'Write',
          payload: { contents: markers.input },
        },
        actionSnapshot: {
          schemaVersion: 2,
          kind: 'tool',
          cwd: '/workspace/project',
          toolName: 'Write',
          operation: 'write',
          path: 'src/index.ts',
          payloadHash,
        },
      },
      scrubOptions,
    )
    const serializedText = JSON.stringify(serialized)

    for (const marker of Object.values(markers)) {
      expect(serializedText).not.toContain(marker)
    }
    expect(serialized.actionSnapshot).toMatchObject({
      schemaVersion: 2,
      kind: 'tool',
      toolName: 'Write',
      operation: 'write',
      path: 'src/index.ts',
      payloadHash,
    })
    expect(serialized.replayContext).toEqual({
      cwd: '/workspace/project',
      kind: 'tool',
      toolName: 'Write',
    })
  })

  it.each([
    { event: 'PostToolUse', success: true },
    { event: 'post_tool_use_failure', success: false },
  ])('allowlists compact $event telemetry across host event casing', ({ event, success }) => {
    const timestamp = '2026-08-22T05:00:00.000Z'
    const bodyMarker = 'task ten serializer host body canary'
    const successFailureMarker = 'task ten success failure metadata canary'
    const correlationId = '1234567890abcdef'
    const failureType = success ? successFailureMarker : 'permission_denied'
    const errorMessage = success ? successFailureMarker : 'Command denied safely'
    const serialized = serializeAuditRecordV3(
      {
        timestamp,
        schemaVersion: 1,
        event,
        toolName: 'Read',
        success,
        durationMs: 19,
        cwdRelative: 'packages/app',
        inputBytes: 23,
        outputBytes: 29,
        failureType,
        errorMessage,
        toolInvocationCorrelationId: correlationId,
        tool_input: { value: bodyMarker },
        toolInput: { value: bodyMarker },
        input: bodyMarker,
        arguments: { value: bodyMarker },
        tool_output: bodyMarker,
        toolOutput: bodyMarker,
        tool_response: bodyMarker,
        toolResponse: bodyMarker,
        tool_result: bodyMarker,
        output: bodyMarker,
        result: bodyMarker,
        stdout: bodyMarker,
        stderr: bodyMarker,
        message: bodyMarker,
        error: bodyMarker,
        metadata: { value: bodyMarker },
      },
      scrubOptions,
    )

    expect(serialized).toEqual({
      schemaVersion: 3,
      timestamp,
      event,
      toolName: 'Read',
      success,
      durationMs: 19,
      cwdRelative: 'packages/app',
      inputBytes: 23,
      outputBytes: 29,
      ...(success ? {} : { failureType, errorMessage }),
      toolInvocationCorrelationId: correlationId,
    })
    expect(JSON.stringify(serialized)).not.toContain(bodyMarker)
    expect(JSON.stringify(serialized)).not.toContain(successFailureMarker)
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

  it('serializes compact records before delegating bounded rotation', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'belay-audit-io-rotation-'))
    tempDirs.push(tempDir)
    const auditPath = path.join(tempDir, 'audit.ndjson')
    const bodyMarker = 'task eleven raw body canary'
    const fingerprints = ['first', 'second'].map((value) =>
      createHash('sha256').update(value).digest('hex'),
    )

    for (const fingerprint of fingerprints) {
      await appendAuditRecord(
        auditPath,
        {
          event: 'preToolUse',
          kind: 'tool',
          fingerprint,
          summary: bodyMarker,
          tool_input: { contents: bodyMarker },
          actionSnapshot: {
            schemaVersion: 2,
            kind: 'tool',
            cwd: '/workspace/project',
            toolName: 'Write',
            operation: 'write',
            path: `src/${fingerprint.slice(0, 8)}.ts`,
          },
        },
        scrubOptions,
        { maxBytes: 1, maxFiles: 2 },
      )
    }

    const retained = [
      JSON.parse((await readFile(`${auditPath}.1`, 'utf8')).trim()),
      JSON.parse((await readFile(auditPath, 'utf8')).trim()),
    ] as Record<string, unknown>[]
    expect(retained.map((record) => record.fingerprint)).toEqual(fingerprints)
    expect(JSON.stringify(retained)).not.toContain(bodyMarker)
    expect(retained.every((record) => record.schemaVersion === 3)).toBe(true)
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
