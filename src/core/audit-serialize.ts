import { createHash } from 'node:crypto'
import { appendFile, mkdir } from 'node:fs/promises'
import path from 'node:path'
import { scrubString, scrubValue } from './scrub.js'
import type { ScrubOptions } from './types.js'

export const AUDIT_SCHEMA_VERSION = 3

const ISO8601_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/
const HEX64_PATTERN = /^[a-f0-9]{64}$/
const SCRUB_PLACEHOLDERS = new Set(['<timestamp>', '<high-entropy>', '<approval-id>', '<uuid>'])

const PRESERVED_HASH_FIELDS = new Set([
  'fingerprint',
  'commandFingerprint',
  'effectIRHash',
  'payloadHash',
  'configFingerprint',
  'runtimeArtifactHash',
  'decisionConfigFingerprint',
  'receiptHash',
])

const PRESERVED_LITERAL_FIELDS = new Set([
  'timestamp',
  'approvalCorrelationId',
  'runtimeVersion',
  'runtimeBuildStamp',
  'boundaryProfile',
  'schemaVersion',
  'imageId',
  'mirrorBackend',
  'wouldMediate',
  'exitCode',
  'timedOut',
])

const SCRUBBED_CONTAINER_FIELDS = new Set([
  'summary',
  'command',
  'payload',
  'replayContext',
  'actionSnapshot',
  'assessment',
  'predictedAssessment',
  'observedAssessment',
])

export function approvalCorrelationId(approvalId: string): string {
  return createHash('sha256').update(approvalId).digest('hex').slice(0, 16)
}

export function isValidApprovalCorrelationId(value: string): boolean {
  return /^[a-f0-9]{16}$/.test(value)
}

export function isValidAuditTimestamp(value: string): boolean {
  if (SCRUB_PLACEHOLDERS.has(value) || !ISO8601_PATTERN.test(value)) {
    return false
  }
  return !Number.isNaN(Date.parse(value))
}

export function isValidAuditFingerprint(value: string): boolean {
  return HEX64_PATTERN.test(value) && !SCRUB_PLACEHOLDERS.has(value)
}

function isValidPreservedHashField(field: string, value: string): boolean {
  if (field === 'receiptHash') {
    return HEX64_PATTERN.test(value)
  }
  if (field === 'imageId') {
    return /^sha256:[a-f0-9]{64}$/.test(value)
  }
  return isValidAuditFingerprint(value)
}

function scrubAuditContainer(value: unknown, options: ScrubOptions): unknown {
  return scrubValue(value, {
    ...options,
    maskHighEntropyStrings: true,
  })
}

function serializeAuditField(key: string, value: unknown, options: ScrubOptions): unknown {
  if (value === undefined) {
    return undefined
  }

  if (key === 'approvalId') {
    return undefined
  }

  if (key === 'ts' && typeof value === 'string' && isValidAuditTimestamp(value)) {
    return undefined
  }

  if (PRESERVED_LITERAL_FIELDS.has(key)) {
    if (key === 'timestamp' && typeof value === 'string' && isValidAuditTimestamp(value)) {
      return value
    }
    if (
      key === 'approvalCorrelationId' &&
      typeof value === 'string' &&
      isValidApprovalCorrelationId(value)
    ) {
      return value
    }
    if (
      (key === 'runtimeVersion' || key === 'runtimeBuildStamp' || key === 'boundaryProfile') &&
      typeof value === 'string' &&
      value.length > 0
    ) {
      return value
    }
    if (key === 'schemaVersion' && typeof value === 'number') {
      return value
    }
    if (key === 'mirrorBackend' && value === 'file_copy') {
      return value
    }
    if (key === 'wouldMediate' && value === true) {
      return true
    }
    if (key === 'exitCode' && (value === null || Number.isSafeInteger(value))) {
      return value
    }
    if (key === 'timedOut' && typeof value === 'boolean') {
      return value
    }
    if (key === 'imageId' && typeof value === 'string' && /^sha256:[a-f0-9]{64}$/.test(value)) {
      return value
    }
    return undefined
  }

  if (PRESERVED_HASH_FIELDS.has(key) && typeof value === 'string') {
    return isValidPreservedHashField(key, value) ? value : undefined
  }

  if (SCRUBBED_CONTAINER_FIELDS.has(key)) {
    return scrubAuditContainer(value, options)
  }

  if (typeof value === 'string') {
    return scrubString(value, { ...options, maskHighEntropyStrings: true })
  }

  if (value !== null && typeof value === 'object') {
    return scrubAuditContainer(value, options)
  }

  return value
}

export function serializeAuditRecordV3(
  record: Record<string, unknown>,
  options: ScrubOptions,
): Record<string, unknown> {
  const timestamp =
    typeof record.timestamp === 'string' && isValidAuditTimestamp(record.timestamp)
      ? record.timestamp
      : typeof record.ts === 'string' && isValidAuditTimestamp(record.ts)
        ? record.ts
        : new Date().toISOString()

  const serialized: Record<string, unknown> = {
    schemaVersion: AUDIT_SCHEMA_VERSION,
    timestamp,
  }

  if (typeof record.approvalId === 'string' && record.approvalId.length > 0) {
    serialized.approvalCorrelationId = approvalCorrelationId(record.approvalId)
  } else if (
    typeof record.approvalCorrelationId === 'string' &&
    isValidApprovalCorrelationId(record.approvalCorrelationId)
  ) {
    serialized.approvalCorrelationId = record.approvalCorrelationId
  }

  for (const [key, value] of Object.entries(record)) {
    if (key === 'timestamp' || key === 'ts' || key === 'approvalId' || key === 'schemaVersion') {
      continue
    }
    const next = serializeAuditField(key, value, options)
    if (next !== undefined) {
      serialized[key] = next
    }
  }

  return serialized
}

export function parseAuditNdjsonLine(line: string): Record<string, unknown> | null {
  const trimmed = line.trim()
  if (!trimmed) {
    return null
  }
  try {
    const parsed = JSON.parse(trimmed) as Record<string, unknown>
    if (typeof parsed.ts === 'string' && parsed.timestamp === undefined) {
      parsed.timestamp = parsed.ts
      delete parsed.ts
    }
    return parsed
  } catch {
    return null
  }
}

export async function appendAuditRecord(
  auditPath: string,
  record: Record<string, unknown>,
  options: ScrubOptions,
): Promise<void> {
  await mkdir(path.dirname(auditPath), { recursive: true })
  const line = JSON.stringify(serializeAuditRecordV3(record, options))
  await appendFile(auditPath, `${line}\n`, 'utf8')
}
