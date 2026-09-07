import { createHash } from 'node:crypto'
import { appendFile, mkdir } from 'node:fs/promises'
import path from 'node:path'
import { minimizeAuditShellAction } from './audit-replay-context.js'
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
  'summaryHash',
])

const PRESERVED_LITERAL_FIELDS = new Set([
  'timestamp',
  'approvalCorrelationId',
  'toolInvocationCorrelationId',
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

const ORDINARY_GATE_EVENTS = new Set(['beforeShellExecution', 'preToolUse', 'subagentGate'])
const ORDINARY_HOST_EVENTS = new Set(['postToolUse', 'postToolUseFailure'])
const RAW_BODY_FIELDS = new Set([
  'content',
  'contents',
  'input',
  'newContents',
  'newString',
  'new_string',
  'oldString',
  'old_string',
  'output',
  'patch',
  'prompt',
  'source',
  'sourceBody',
  'source_body',
  'stderr',
  'stdout',
  'text',
  'toolInput',
  'toolOutput',
  'toolResponse',
  'tool_input',
  'tool_output',
  'tool_response',
])
const SHELL_TEXT_FIELDS = new Set(['command', 'commandRedacted', 'normalizedAction', 'segment'])

export function approvalCorrelationId(approvalId: string): string {
  return createHash('sha256').update(approvalId).digest('hex').slice(0, 16)
}

const TOOL_USE_UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

/** Normalize Cursor host tool_use_id values before correlation hashing. */
export function canonicalToolUseIdForCorrelation(toolUseId: string): string {
  const trimmed = toolUseId.trim()
  if (trimmed.startsWith('tool_')) {
    const remainder = trimmed.slice('tool_'.length)
    if (TOOL_USE_UUID_PATTERN.test(remainder)) {
      return remainder.toLowerCase()
    }
  }
  if (TOOL_USE_UUID_PATTERN.test(trimmed)) {
    return trimmed.toLowerCase()
  }
  return trimmed
}

export function toolInvocationCorrelationId(toolUseId: string): string {
  return createHash('sha256')
    .update(canonicalToolUseIdForCorrelation(toolUseId))
    .digest('hex')
    .slice(0, 16)
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

function scrubAuditContainer(
  value: unknown,
  options: ScrubOptions,
  minimizeBodies = false,
): unknown {
  const withoutRawBodies = (input: unknown, parentKey?: string): unknown => {
    if (
      typeof input === 'string' &&
      minimizeBodies &&
      parentKey &&
      SHELL_TEXT_FIELDS.has(parentKey)
    ) {
      return minimizeAuditShellAction(input)
    }
    if (Array.isArray(input)) return input.map((child) => withoutRawBodies(child, parentKey))
    if (input && typeof input === 'object') {
      return Object.fromEntries(
        Object.entries(input)
          .filter(
            ([key]) => key !== 'tool_use_id' && (!minimizeBodies || !RAW_BODY_FIELDS.has(key)),
          )
          .map(([key, child]) => [key, withoutRawBodies(child, key)]),
      )
    }
    return input
  }
  return scrubValue(withoutRawBodies(value), {
    ...options,
    maskHighEntropyStrings: true,
  })
}

function scrubbedAuditString(value: string, options: ScrubOptions): string {
  return scrubString(value, { ...options, maskHighEntropyStrings: true })
}

function serializeReplayContext(value: unknown, options: ScrubOptions): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined
  }
  const raw = value as Record<string, unknown>
  if (
    typeof raw.cwd !== 'string' ||
    (raw.kind !== 'shell' && raw.kind !== 'tool' && raw.kind !== 'subagent')
  ) {
    return undefined
  }
  return {
    cwd: scrubbedAuditString(raw.cwd, options),
    kind: raw.kind,
    ...(raw.kind === 'shell' && typeof raw.command === 'string'
      ? { command: scrubbedAuditString(minimizeAuditShellAction(raw.command), options) }
      : {}),
    ...(typeof raw.toolName === 'string'
      ? { toolName: scrubbedAuditString(raw.toolName, options) }
      : {}),
  }
}

function serializeActionSnapshot(value: unknown, options: ScrubOptions): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined
  }
  const raw = value as Record<string, unknown>
  if (
    (raw.schemaVersion !== 1 && raw.schemaVersion !== 2) ||
    (raw.kind !== 'shell' && raw.kind !== 'tool' && raw.kind !== 'subagent') ||
    typeof raw.cwd !== 'string'
  ) {
    return undefined
  }
  const base = {
    schemaVersion: raw.schemaVersion,
    kind: raw.kind,
    cwd: scrubbedAuditString(raw.cwd, options),
  }
  if (raw.schemaVersion === 1) {
    if (typeof raw.normalizedAction !== 'string') {
      return undefined
    }
    return {
      ...base,
      normalizedAction: scrubbedAuditString(
        raw.kind === 'shell'
          ? minimizeAuditShellAction(raw.normalizedAction)
          : raw.normalizedAction,
        options,
      ),
      ...(typeof raw.toolName === 'string'
        ? { toolName: scrubbedAuditString(raw.toolName, options) }
        : {}),
      ...(typeof raw.payloadHash === 'string' && HEX64_PATTERN.test(raw.payloadHash)
        ? { payloadHash: raw.payloadHash }
        : {}),
    }
  }
  if (raw.kind === 'shell') {
    return typeof raw.normalizedAction === 'string'
      ? {
          ...base,
          normalizedAction: scrubbedAuditString(
            minimizeAuditShellAction(raw.normalizedAction),
            options,
          ),
        }
      : undefined
  }
  if (raw.kind === 'tool') {
    if (typeof raw.toolName !== 'string') {
      return undefined
    }
    return {
      ...base,
      toolName: scrubbedAuditString(raw.toolName, options),
      ...(typeof raw.operation === 'string'
        ? { operation: scrubbedAuditString(raw.operation, options) }
        : {}),
      ...(typeof raw.path === 'string' ? { path: scrubbedAuditString(raw.path, options) } : {}),
      ...(typeof raw.payloadHash === 'string' && HEX64_PATTERN.test(raw.payloadHash)
        ? { payloadHash: raw.payloadHash }
        : {}),
    }
  }
  return typeof raw.summaryHash === 'string' && HEX64_PATTERN.test(raw.summaryHash)
    ? {
        ...base,
        ...(typeof raw.toolName === 'string'
          ? { toolName: scrubbedAuditString(raw.toolName, options) }
          : {}),
        summaryHash: raw.summaryHash,
      }
    : undefined
}

function compactGateSummary(record: Record<string, unknown>): string | undefined {
  const snapshot = record.actionSnapshot
  if (snapshot && typeof snapshot === 'object' && !Array.isArray(snapshot)) {
    const raw = snapshot as Record<string, unknown>
    if (raw.kind === 'shell' && typeof raw.normalizedAction === 'string') {
      return minimizeAuditShellAction(raw.normalizedAction)
    }
    if (raw.kind === 'tool') {
      return [raw.toolName, raw.operation, raw.path]
        .filter((part): part is string => typeof part === 'string' && Boolean(part.trim()))
        .join(' ')
    }
    if (raw.kind === 'subagent') {
      const toolName = typeof raw.toolName === 'string' ? raw.toolName : 'subagent'
      const hashPrefix = typeof raw.summaryHash === 'string' ? raw.summaryHash.slice(0, 12) : ''
      return hashPrefix ? `${toolName} ${hashPrefix}` : toolName
    }
  }

  if (record.kind === 'shell' && typeof record.summary === 'string') {
    return minimizeAuditShellAction(record.summary)
  }
  if (record.kind === 'tool' || record.kind === 'subagent') {
    return typeof record.toolName === 'string' ? record.toolName : String(record.kind)
  }
  return undefined
}

function serializeAuditField(
  key: string,
  value: unknown,
  options: ScrubOptions,
  minimizeBodies: boolean,
): unknown {
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
      (key === 'approvalCorrelationId' || key === 'toolInvocationCorrelationId') &&
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

  if (key === 'replayContext') {
    return serializeReplayContext(value, options)
  }

  if (key === 'actionSnapshot') {
    return serializeActionSnapshot(value, options)
  }

  if (SCRUBBED_CONTAINER_FIELDS.has(key)) {
    return scrubAuditContainer(value, options, minimizeBodies)
  }

  if (typeof value === 'string') {
    return scrubbedAuditString(value, options)
  }

  if (value !== null && typeof value === 'object') {
    return scrubAuditContainer(value, options, minimizeBodies)
  }

  return value
}

export function serializeAuditRecordV3(
  record: Record<string, unknown>,
  options: ScrubOptions,
): Record<string, unknown> {
  const event = typeof record.event === 'string' ? record.event : undefined
  const minimizeBodies = Boolean(
    event && (ORDINARY_GATE_EVENTS.has(event) || ORDINARY_HOST_EVENTS.has(event)),
  )
  const compactSummary =
    event && ORDINARY_GATE_EVENTS.has(event) ? compactGateSummary(record) : undefined
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
    if (
      key === 'timestamp' ||
      key === 'ts' ||
      key === 'approvalId' ||
      key === 'tool_use_id' ||
      key === 'schemaVersion'
    ) {
      continue
    }
    if (minimizeBodies && RAW_BODY_FIELDS.has(key)) {
      continue
    }
    if (minimizeBodies && ORDINARY_HOST_EVENTS.has(event ?? '') && key === 'summary') {
      continue
    }
    const next = serializeAuditField(
      key,
      key === 'summary' && compactSummary !== undefined ? compactSummary : value,
      options,
      minimizeBodies,
    )
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
