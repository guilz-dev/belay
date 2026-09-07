import { createHash } from 'node:crypto'
import path from 'node:path'

import { hashReplayPayload } from './audit-replay-context.js'
import { canonicalStringify } from './fingerprint.js'
import { redactToolInvocationId } from './replay-scrub.js'
import { scrubValue } from './scrub.js'
import type { ScrubOptions } from './types.js'

export interface ObservedAuditProjection {
  summary: string
  observedInputBytes: number
  observedOutputBytes: number
  observedPayloadHash: string
  observedCwd?: string
}

function utf8ByteLength(value: unknown): number {
  if (value === undefined || value === null) {
    return 0
  }
  if (typeof value === 'string') {
    return Buffer.byteLength(value, 'utf8')
  }
  return Buffer.byteLength(JSON.stringify(value), 'utf8')
}

function scrubPayloadForHash(
  payload: Record<string, unknown>,
  scrubOptions: ScrubOptions,
): Record<string, unknown> {
  const rawToolUseId = typeof payload.tool_use_id === 'string' ? payload.tool_use_id : undefined
  const redacted = redactToolInvocationId(payload, rawToolUseId)
  return scrubValue(redacted, { ...scrubOptions, maskHighEntropyStrings: true }) as Record<
    string,
    unknown
  >
}

function hashObservedPayload(payload: Record<string, unknown>, scrubOptions: ScrubOptions): string {
  return hashReplayPayload(scrubPayloadForHash(payload, scrubOptions))
}

function repoRelativePath(repoRoot: string, cwd: string): string {
  const resolvedRepo = path.resolve(repoRoot)
  const resolvedCwd = path.resolve(cwd)
  const relative = path.relative(resolvedRepo, resolvedCwd)
  return relative || '.'
}

function extractToolInputRecord(toolInput: unknown): Record<string, unknown> | null {
  if (!toolInput || typeof toolInput !== 'object' || Array.isArray(toolInput)) {
    return null
  }
  return toolInput as Record<string, unknown>
}

function extractFilePathFromInput(input: Record<string, unknown>): string | undefined {
  for (const key of ['path', 'file_path', 'target_file', 'filePath']) {
    if (typeof input[key] === 'string' && input[key].trim()) {
      return input[key].trim()
    }
  }
  return undefined
}

function byteLengthField(input: Record<string, unknown>, key: string): number | undefined {
  const value = input[key]
  return typeof value === 'string' ? utf8ByteLength(value) : undefined
}

function hashText(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 12)
}

export function compactToolGateSummary(
  toolName: string,
  toolInput: unknown,
  fallback = '',
  scrubOptions?: ScrubOptions,
  rawToolUseId?: string,
): string {
  const rawInput = extractToolInputRecord(toolInput)
  const normalizedName = toolName.trim() || 'Tool'

  if (!rawInput) {
    return fallback.trim() || normalizedName
  }
  const input = redactToolInvocationId(rawInput, rawToolUseId) as Record<string, unknown>

  const filePath = extractFilePathFromInput(input)
  if (filePath) {
    const readLike = /read|grep|glob|search|list/i.test(normalizedName)
    if (readLike) {
      return `${normalizedName} ${filePath}`
    }
    const oldBytes = byteLengthField(input, 'old_string')
    const newBytes = byteLengthField(input, 'new_string')
    const contentsBytes = byteLengthField(input, 'contents')
    const parts = [`${normalizedName} ${filePath}`]
    if (oldBytes !== undefined || newBytes !== undefined) {
      parts.push(`(old ${oldBytes ?? 0}B, new ${newBytes ?? 0}B)`)
    } else if (contentsBytes !== undefined) {
      parts.push(`(${contentsBytes}B)`)
    }
    return parts.join(' ')
  }

  if (typeof input.command === 'string' && input.command.trim()) {
    return `Shell: ${input.command.trim()}`
  }

  if (typeof input.pattern === 'string' && input.pattern.trim()) {
    const pattern = input.pattern.trim()
    return `${normalizedName} pattern (${utf8ByteLength(pattern)}B, hash ${hashText(pattern)})`
  }

  const keys = Object.keys(input).filter((key) => key !== 'working_directory')
  if (scrubOptions && keys.length > 0) {
    const scrubbed = scrubValue(input, { ...scrubOptions, maskHighEntropyStrings: true })
    const serialized = canonicalStringify(scrubbed)
    return `${normalizedName} (${utf8ByteLength(serialized)}B, hash ${hashText(serialized)})`
  }
  if (keys.length === 0) {
    return normalizedName
  }
  return `${normalizedName} (${keys.join(', ')})`
}

export function compactSubagentGateSummary(payload: Record<string, unknown>): string {
  const kind =
    payload.tool_name === 'Task' ? 'Task' : String(payload.subagent_type ?? 'generalPurpose')
  const toolInput = extractToolInputRecord(payload.tool_input)
  let text = ''
  if (toolInput) {
    const description = typeof toolInput.description === 'string' ? toolInput.description : ''
    const prompt = typeof toolInput.prompt === 'string' ? toolInput.prompt : ''
    text = [description, prompt].filter(Boolean).join(' ')
  } else {
    const task = payload.task
    if (typeof task === 'string') {
      text = task
    } else if (task && typeof task === 'object') {
      const taskObj = task as Record<string, unknown>
      const description = typeof taskObj.description === 'string' ? taskObj.description : ''
      const prompt = typeof taskObj.prompt === 'string' ? taskObj.prompt : ''
      text = [description, prompt].filter(Boolean).join(' ')
    }
  }
  if (!text.trim()) {
    return kind
  }
  return `${kind} (prompt ${utf8ByteLength(text)}B, hash ${hashText(text)})`
}

export function projectObservedAudit(
  payload: Record<string, unknown>,
  eventName: string,
  repoRoot: string,
  scrubOptions: ScrubOptions,
): ObservedAuditProjection {
  const toolName = typeof payload.tool_name === 'string' ? payload.tool_name : 'tool'
  const rawToolUseId = typeof payload.tool_use_id === 'string' ? payload.tool_use_id : undefined
  const summaryPayload = redactToolInvocationId(payload, rawToolUseId) as Record<string, unknown>
  const toolInput = summaryPayload.tool_input
  const toolOutput = payload.tool_output
  const inputBytes = utf8ByteLength(toolInput)
  const outputBytes = utf8ByteLength(toolOutput)
  const observedPayloadHash = hashObservedPayload(payload, scrubOptions)

  const cwdCandidate =
    (typeof payload.cwd === 'string' && payload.cwd) ||
    (extractToolInputRecord(toolInput)?.working_directory as string | undefined) ||
    undefined
  const observedCwd = cwdCandidate?.trim()
    ? repoRelativePath(repoRoot, cwdCandidate.trim())
    : undefined

  const input = extractToolInputRecord(toolInput)
  const filePath = input ? extractFilePathFromInput(input) : undefined
  const serializedInput = canonicalStringify(
    scrubValue(input ?? {}, { ...scrubOptions, maskHighEntropyStrings: true }),
  )
  const inputSummary = filePath
    ? `${toolName} ${filePath}`
    : `${toolName} (${utf8ByteLength(serializedInput)}B, hash ${hashText(serializedInput)})`
  const failureSuffix =
    eventName === 'postToolUseFailure' && typeof payload.failure_type === 'string'
      ? ` failed:${payload.failure_type}`
      : ''
  const byteSuffix = `(${inputBytes} B in, ${outputBytes} B out)`
  const summary = `${inputSummary}${failureSuffix} ${byteSuffix}`.trim()

  return {
    summary,
    observedInputBytes: inputBytes,
    observedOutputBytes: outputBytes,
    observedPayloadHash,
    ...(observedCwd ? { observedCwd } : {}),
  }
}
