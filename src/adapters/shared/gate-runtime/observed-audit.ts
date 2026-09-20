import { homedir } from 'node:os'
import path from 'node:path'

import { toolInvocationCorrelationId } from '../../../core/audit-serialize.js'
import type { CompactHostTelemetryV1 } from '../../../core/audit-types.js'
import { scrubOptionsFromConfig } from '../../../core/config.js'
import { scrubString } from '../../../core/scrub.js'
import type { GateRuntimeContext, GateRuntimeDeps } from '../gate-runtime.js'

type ObservedAuditContext = Pick<GateRuntimeContext, 'repoRoot' | 'config'>
type ObservedAuditDeps = Pick<GateRuntimeDeps, 'appendAudit'>

function firstDefinedPayloadValue(
  payload: Record<string, unknown>,
  keys: readonly string[],
): unknown {
  for (const key of keys) {
    if (payload[key] !== undefined) {
      return payload[key]
    }
  }
  return undefined
}

function auditPayloadByteLength(value: unknown): number | undefined {
  if (value === undefined) {
    return undefined
  }
  if (typeof value === 'string') {
    return Buffer.byteLength(value, 'utf8')
  }
  try {
    const serialized = JSON.stringify(value)
    return serialized === undefined ? undefined : Buffer.byteLength(serialized, 'utf8')
  } catch {
    return undefined
  }
}

function normalizedFailureType(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined
  }
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 64)
  return normalized || undefined
}

const POSIX_USER_HOME_PATTERN =
  /(?<![A-Za-z0-9:])(?:\/(?:var\/home|Users|home)\/[^/\\\s"'`,;:!?()]+|\/root)(?:\/[^/\\\s"'`,;:!?()]+)*(?:\/)?(?=$|[\s"'`,;:!?()])/g
const WINDOWS_USER_HOME_PATTERN =
  /[A-Za-z]:[\\/]Users[\\/][^\\/\s"'`,;:!?()]+(?:[\\/][^\s"'`,;:!?()]+)*/gi

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function configuredHomeRoots(): string[] {
  const driveHome =
    process.env.HOMEDRIVE && process.env.HOMEPATH
      ? `${process.env.HOMEDRIVE}${process.env.HOMEPATH}`
      : undefined
  const candidates = [process.env.HOME, process.env.USERPROFILE, driveHome, homedir()]
  return [
    ...new Set(
      candidates
        .filter((candidate): candidate is string => Boolean(candidate?.trim()))
        .map((candidate) => candidate.trim().replace(/[\\/]+$/, ''))
        .filter((candidate) => path.isAbsolute(candidate) || /^[A-Za-z]:[\\/]/.test(candidate)),
    ),
  ].sort((left, right) => right.length - left.length)
}

function scrubAbsoluteHomePaths(value: string): string {
  let scrubbed = value
  for (const homeRoot of configuredHomeRoots()) {
    const pattern = new RegExp(
      `${escapeRegExp(homeRoot)}(?:[\\\\/][^\\\\/\\s"'\`,;:!?()]+)*(?=$|[\\s"'\`,;:!?()])`,
      'gi',
    )
    scrubbed = scrubbed.replace(pattern, '<home-path>')
  }
  return scrubbed
    .replace(POSIX_USER_HOME_PATTERN, '<home-path>')
    .replace(WINDOWS_USER_HOME_PATTERN, '<home-path>')
}

function normalizedFailureMessage(
  value: unknown,
  rawToolUseId: string | undefined,
  ctx: ObservedAuditContext,
): string | undefined {
  if (typeof value !== 'string') {
    return undefined
  }
  const withoutCorrelationId = rawToolUseId
    ? value.replaceAll(rawToolUseId, '<tool-use-id>')
    : value
  const withoutHomePaths = scrubAbsoluteHomePaths(withoutCorrelationId)
  const normalized = scrubString(
    withoutHomePaths.replace(/\s+/g, ' ').trim(),
    scrubOptionsFromConfig(ctx.config),
  ).slice(0, 512)
  return normalized || undefined
}

function telemetryCwdRelative(
  repoRoot: string,
  payload: Record<string, unknown>,
  actionCwd?: string,
): string | undefined {
  const payloadCwd = typeof payload.cwd === 'string' && payload.cwd.trim() ? payload.cwd : undefined
  const candidate = actionCwd ?? payloadCwd ?? repoRoot
  const resolved = path.isAbsolute(candidate)
    ? path.resolve(candidate)
    : path.resolve(repoRoot, candidate)
  const relative = path.relative(path.resolve(repoRoot), resolved)
  if (relative === '') {
    return '.'
  }
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    return undefined
  }
  return relative.split(path.sep).join('/')
}

function compactHostTelemetry(
  ctx: ObservedAuditContext,
  eventName: string,
  payload: Record<string, unknown>,
  actionCwd?: string,
): CompactHostTelemetryV1 {
  const rawToolUseId = typeof payload.tool_use_id === 'string' ? payload.tool_use_id : undefined
  const rawDuration = firstDefinedPayloadValue(payload, ['duration', 'duration_ms', 'durationMs'])
  const durationMs =
    typeof rawDuration === 'number' && Number.isFinite(rawDuration) && rawDuration >= 0
      ? Math.round(rawDuration)
      : undefined
  const explicitSuccess = firstDefinedPayloadValue(payload, ['success', 'ok'])
  const isError = firstDefinedPayloadValue(payload, ['is_error', 'isError'])
  const success =
    typeof explicitSuccess === 'boolean'
      ? explicitSuccess
      : typeof isError === 'boolean'
        ? !isError
        : !/(?:failure|error)$/i.test(eventName)
  const input = firstDefinedPayloadValue(payload, ['tool_input', 'toolInput', 'input', 'arguments'])
  let output = firstDefinedPayloadValue(payload, [
    'tool_output',
    'toolOutput',
    'tool_response',
    'toolResponse',
    'tool_result',
    'output',
    'result',
  ])
  if (output === undefined && (payload.stdout !== undefined || payload.stderr !== undefined)) {
    output = { stdout: payload.stdout, stderr: payload.stderr }
  }
  const failureType = normalizedFailureType(
    success === false
      ? firstDefinedPayloadValue(payload, [
          'failure_type',
          'failureType',
          'error_type',
          'errorType',
        ])
      : undefined,
  )
  const errorValue =
    success === false
      ? firstDefinedPayloadValue(payload, ['error_message', 'errorMessage', 'message', 'error'])
      : undefined
  const toolName = firstDefinedPayloadValue(payload, ['tool_name', 'toolName'])
  const cwdRelative = telemetryCwdRelative(ctx.repoRoot, payload, actionCwd)
  const inputBytes = auditPayloadByteLength(input)
  const outputBytes = auditPayloadByteLength(output)
  const errorMessage = normalizedFailureMessage(errorValue, rawToolUseId, ctx)

  return {
    schemaVersion: 1,
    event: eventName,
    ...(typeof toolName === 'string' && toolName.trim()
      ? { toolName: toolName.trim().slice(0, 128) }
      : {}),
    success,
    ...(durationMs !== undefined ? { durationMs } : {}),
    ...(cwdRelative !== undefined ? { cwdRelative } : {}),
    ...(inputBytes !== undefined ? { inputBytes } : {}),
    ...(outputBytes !== undefined ? { outputBytes } : {}),
    ...(failureType ? { failureType } : {}),
    ...(errorMessage ? { errorMessage } : {}),
    ...(rawToolUseId
      ? { toolInvocationCorrelationId: toolInvocationCorrelationId(rawToolUseId) }
      : {}),
  }
}

export async function appendObservedAudit(
  ctx: GateRuntimeContext,
  deps: ObservedAuditDeps,
  eventName: string,
  payload: Record<string, unknown>,
  actionCwd?: string,
): Promise<void> {
  await deps.appendAudit(ctx, { ...compactHostTelemetry(ctx, eventName, payload, actionCwd) })
}
