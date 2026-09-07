import { createHash } from 'node:crypto'
import path from 'node:path'

import type { GatedActionKind } from './gate-contract.js'
import { lexShell } from './shell-tokenizer.js'
import type { ClassifyResult } from './types.js'

/** Preserved action context for simulate triage — not a safety gate. */
export interface AuditReplayContext {
  cwd: string
  kind: GatedActionKind
  command?: string
  toolName?: string
  /** @deprecated Legacy read compatibility only. New writers never retain replay payloads. */
  payload?: Record<string, unknown>
}

/** Legacy classifier-facing action snapshot retained for historical audit reads. */
export interface AuditActionSnapshotV1 {
  schemaVersion: 1
  kind: GatedActionKind
  cwd: string
  normalizedAction: string
  toolName?: string
  payloadHash?: string
}

export type AuditToolOperation = 'delete' | 'read' | 'replace' | 'write'

/** Compact classifier-facing snapshot used by all new gate writes. */
export type AuditActionSnapshotV2 =
  | {
      schemaVersion: 2
      kind: 'shell'
      cwd: string
      normalizedAction: string
    }
  | {
      schemaVersion: 2
      kind: 'tool'
      cwd: string
      toolName: string
      operation?: AuditToolOperation
      path?: string
      payloadHash?: string
    }
  | {
      schemaVersion: 2
      kind: 'subagent'
      cwd: string
      toolName?: string
      summaryHash: string
    }

/** Stored snapshot compatibility union: v1 reads plus v2 writes. */
export type AuditActionSnapshot = AuditActionSnapshotV1 | AuditActionSnapshotV2

export type AuditReplayNonReplayableReason =
  | 'invalid_v2_snapshot'
  | 'subagent_summary_body_omitted'
  | 'tool_projection_incomplete'

export type ParsedAuditActionSnapshot =
  | {
      replayable: true
      sourceSchemaVersion: 1 | 2
      kind: GatedActionKind
      cwd: string
      command?: string
      toolName?: string
      operation?: AuditToolOperation
      path?: string
      payloadHash?: string
    }
  | {
      replayable: false
      sourceSchemaVersion: 2
      kind?: GatedActionKind
      cwd?: string
      reason: AuditReplayNonReplayableReason
    }

export interface ReplayActionLike {
  cwd?: string
  kind?: string
  command?: string
  toolName?: string
  payload?: Record<string, unknown>
}

const HASH_PATTERN = /^[a-f0-9]{64}$/
const AUDIT_SOURCE_PLACEHOLDER = '[belay audit source omitted]'
const EXPANDING_HEREDOC_PLACEHOLDER = '$(belay-audit-source-omitted)'
const INLINE_SOURCE_FLAGS = new Map<string, ReadonlySet<string>>([
  ['bash', new Set(['-c'])],
  ['dash', new Set(['-c'])],
  ['fish', new Set(['-c'])],
  ['node', new Set(['-e', '--eval'])],
  ['osascript', new Set(['-e'])],
  ['perl', new Set(['-e', '-E'])],
  ['python', new Set(['-c'])],
  ['python3', new Set(['-c'])],
  ['ruby', new Set(['-e'])],
  ['sh', new Set(['-c'])],
  ['zsh', new Set(['-c'])],
])

interface TextReplacement {
  start: number
  end: number
  value: string
}

function applyTextReplacements(input: string, replacements: TextReplacement[]): string {
  let output = input
  for (const replacement of replacements.sort((left, right) => right.start - left.start)) {
    output = `${output.slice(0, replacement.start)}${replacement.value}${output.slice(replacement.end)}`
  }
  return output.trim()
}

/**
 * Keep shell structure useful for replay while removing executable source bodies. The replacement
 * for an expanding heredoc is deliberately indeterminate so omission cannot make replay more
 * permissive than the captured action.
 */
export function minimizeAuditShellAction(command: string): string {
  const lexed = lexShell(command)
  const replacements: TextReplacement[] = lexed.heredocs
    .filter((heredoc) => heredoc.body.end > heredoc.body.start)
    .map((heredoc) => ({
      start: heredoc.body.start,
      end: heredoc.body.end,
      value: `${heredoc.expands ? EXPANDING_HEREDOC_PLACEHOLDER : AUDIT_SOURCE_PLACEHOLDER}\n`,
    }))

  for (let index = 0; index < lexed.tokens.length; index += 1) {
    const token = lexed.tokens[index]
    if (token?.kind !== 'word') {
      continue
    }
    const interpreter = path.basename(token.value).toLowerCase()
    const flags = INLINE_SOURCE_FLAGS.get(interpreter)
    if (!flags) {
      continue
    }

    for (let cursor = index + 1; cursor < lexed.tokens.length; cursor += 1) {
      const candidate = lexed.tokens[cursor]
      if (!candidate || candidate.kind === 'operator') {
        break
      }
      const exactFlag = flags.has(candidate.value)
      const assignedFlag = [...flags].find((flag) => candidate.value.startsWith(`${flag}=`))
      if (assignedFlag) {
        replacements.push({
          start: candidate.start,
          end: candidate.end,
          value: `${assignedFlag}='${AUDIT_SOURCE_PLACEHOLDER}'`,
        })
        break
      }
      if (!exactFlag) {
        continue
      }
      const source = lexed.tokens[cursor + 1]
      if (source?.kind === 'word') {
        replacements.push({
          start: source.start,
          end: source.end,
          value: `'${AUDIT_SOURCE_PLACEHOLDER}'`,
        })
      }
      break
    }
  }

  return applyTextReplacements(command, replacements)
}

export function hashReplayPayload(payload: Record<string, unknown>): string {
  return createHash('sha256').update(JSON.stringify(payload)).digest('hex')
}

function validKind(value: unknown): value is GatedActionKind {
  return value === 'shell' || value === 'tool' || value === 'subagent'
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && Boolean(value.trim())
}

function replayKindOrDefault(kind: GatedActionKind, replayKind: unknown): GatedActionKind {
  return validKind(replayKind) ? replayKind : kind
}

function toolInput(payload: Record<string, unknown>): Record<string, unknown> {
  const nested = payload.tool_input
  return nested && typeof nested === 'object' && !Array.isArray(nested)
    ? (nested as Record<string, unknown>)
    : payload
}

function normalizedTargetPath(input: Record<string, unknown>): string | undefined {
  for (const key of ['path', 'file_path', 'target_file', 'filePath', 'filename']) {
    const candidate = input[key]
    if (nonEmptyString(candidate)) {
      return path.normalize(candidate.trim())
    }
  }
  return undefined
}

function patchProjection(input: Record<string, unknown>): {
  operation?: AuditToolOperation
  path?: string
} {
  const patch = ['patch', 'input', 'text']
    .map((key) => input[key])
    .find((value): value is string => nonEmptyString(value))
  if (!patch) {
    return {}
  }
  const targets = [...patch.matchAll(/^\*\*\* (Add|Delete|Update) File: (.+)$/gm)].map((match) => ({
    operation: match[1] === 'Delete' ? ('delete' as const) : ('write' as const),
    path: match[2]?.trim(),
  }))
  if (targets.length !== 1 || !targets[0]?.path) {
    return {}
  }
  return { operation: targets[0].operation, path: path.normalize(targets[0].path) }
}

function toolProjection(
  toolName: string,
  payload: Record<string, unknown> | undefined,
): { operation?: AuditToolOperation; path?: string } {
  if (!payload) {
    return {}
  }
  const input = toolInput(payload)
  const lowered = toolName.trim().toLowerCase().replaceAll(/[_-]/g, '')
  if (lowered === 'applypatch' || nonEmptyString(input.patch)) {
    return patchProjection(input)
  }

  const targetPath = normalizedTargetPath(input)
  if (['delete', 'remove'].includes(lowered)) {
    return { operation: 'delete', path: targetPath }
  }
  if (['edit', 'multiedit', 'strreplace', 'replace'].includes(lowered)) {
    return { operation: 'replace', path: targetPath }
  }
  if (['write', 'create'].includes(lowered)) {
    return { operation: 'write', path: targetPath }
  }
  if (['read', 'view'].includes(lowered)) {
    return { operation: 'read', path: targetPath }
  }
  return {}
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

export function buildAuditActionSnapshot(
  kind: GatedActionKind,
  result: Pick<ClassifyResult, 'normalizedCommand' | 'summary'>,
  replayAction?: ReplayActionLike,
): AuditActionSnapshotV2 | undefined {
  if (!replayAction?.cwd) {
    return undefined
  }
  const resolvedKind = replayKindOrDefault(kind, replayAction.kind)

  if (resolvedKind === 'shell') {
    const normalizedAction = minimizeAuditShellAction(
      result.normalizedCommand ?? replayAction.command ?? result.summary ?? '',
    )
    if (!normalizedAction) {
      return undefined
    }
    return {
      schemaVersion: 2,
      kind: 'shell',
      cwd: replayAction.cwd,
      normalizedAction,
    }
  }

  if (resolvedKind === 'tool') {
    const toolName = replayAction.toolName?.trim() || 'unknown'
    const projection = toolProjection(toolName, replayAction.payload)
    return {
      schemaVersion: 2,
      kind: 'tool',
      cwd: replayAction.cwd,
      toolName,
      ...projection,
      ...(replayAction.payload && Object.keys(replayAction.payload).length > 0
        ? { payloadHash: hashReplayPayload(replayAction.payload) }
        : {}),
    }
  }

  const summary =
    result.summary ?? replayAction.command ?? JSON.stringify(replayAction.payload ?? {})
  return {
    schemaVersion: 2,
    kind: 'subagent',
    cwd: replayAction.cwd,
    ...(replayAction.toolName?.trim() ? { toolName: replayAction.toolName.trim() } : {}),
    summaryHash: sha256(summary),
  }
}

function invalidV2Snapshot(snapshot: Record<string, unknown>): ParsedAuditActionSnapshot {
  return {
    replayable: false,
    sourceSchemaVersion: 2,
    ...(validKind(snapshot.kind) ? { kind: snapshot.kind } : {}),
    ...(nonEmptyString(snapshot.cwd) ? { cwd: snapshot.cwd } : {}),
    reason: 'invalid_v2_snapshot',
  }
}

export function parseAuditActionSnapshot(record: {
  actionSnapshot?: unknown
}): ParsedAuditActionSnapshot | null {
  const raw = record.actionSnapshot
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return null
  }
  const snapshot = raw as Record<string, unknown>

  if (snapshot.schemaVersion === 1) {
    if (
      !validKind(snapshot.kind) ||
      !nonEmptyString(snapshot.cwd) ||
      !nonEmptyString(snapshot.normalizedAction)
    ) {
      return null
    }
    return {
      replayable: true,
      sourceSchemaVersion: 1,
      kind: snapshot.kind,
      cwd: snapshot.cwd,
      command: snapshot.normalizedAction,
      ...(nonEmptyString(snapshot.toolName) ? { toolName: snapshot.toolName } : {}),
      ...(nonEmptyString(snapshot.payloadHash) ? { payloadHash: snapshot.payloadHash } : {}),
    }
  }

  if (snapshot.schemaVersion !== 2) {
    return null
  }
  if (!validKind(snapshot.kind) || !nonEmptyString(snapshot.cwd)) {
    return invalidV2Snapshot(snapshot)
  }

  if (snapshot.kind === 'shell') {
    if (!nonEmptyString(snapshot.normalizedAction)) {
      return invalidV2Snapshot(snapshot)
    }
    return {
      replayable: true,
      sourceSchemaVersion: 2,
      kind: 'shell',
      cwd: snapshot.cwd,
      command: snapshot.normalizedAction,
    }
  }

  if (snapshot.kind === 'subagent') {
    if (!nonEmptyString(snapshot.summaryHash) || !HASH_PATTERN.test(snapshot.summaryHash)) {
      return invalidV2Snapshot(snapshot)
    }
    return {
      replayable: false,
      sourceSchemaVersion: 2,
      kind: 'subagent',
      cwd: snapshot.cwd,
      reason: 'subagent_summary_body_omitted',
    }
  }

  if (
    !nonEmptyString(snapshot.toolName) ||
    !nonEmptyString(snapshot.operation) ||
    !['delete', 'read', 'replace', 'write'].includes(snapshot.operation) ||
    !nonEmptyString(snapshot.path)
  ) {
    return {
      replayable: false,
      sourceSchemaVersion: 2,
      kind: 'tool',
      cwd: snapshot.cwd,
      reason: 'tool_projection_incomplete',
    }
  }
  return {
    replayable: true,
    sourceSchemaVersion: 2,
    kind: 'tool',
    cwd: snapshot.cwd,
    toolName: snapshot.toolName,
    operation: snapshot.operation as AuditToolOperation,
    path: path.normalize(snapshot.path),
    ...(nonEmptyString(snapshot.payloadHash) && HASH_PATTERN.test(snapshot.payloadHash)
      ? { payloadHash: snapshot.payloadHash }
      : {}),
  }
}

export function buildAuditReplayContext(
  kind: GatedActionKind,
  result: Pick<ClassifyResult, 'normalizedCommand' | 'summary'>,
  replayAction?: ReplayActionLike,
): AuditReplayContext | undefined {
  if (!replayAction?.cwd) {
    return undefined
  }
  const resolvedKind = replayKindOrDefault(kind, replayAction.kind)
  return {
    cwd: replayAction.cwd,
    kind: resolvedKind,
    ...(resolvedKind === 'shell'
      ? {
          command: minimizeAuditShellAction(
            result.normalizedCommand ?? replayAction.command ?? result.summary ?? '',
          ),
        }
      : {}),
    ...(replayAction.toolName?.trim() ? { toolName: replayAction.toolName.trim() } : {}),
  }
}

export function parseAuditReplayContext(record: {
  replayContext?: unknown
}): AuditReplayContext | null {
  const raw = record.replayContext
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return null
  }
  const ctx = raw as Record<string, unknown>
  if (!nonEmptyString(ctx.cwd) || !validKind(ctx.kind)) {
    return null
  }
  return {
    cwd: ctx.cwd,
    kind: ctx.kind,
    ...(typeof ctx.command === 'string' ? { command: ctx.command } : {}),
    ...(typeof ctx.toolName === 'string' ? { toolName: ctx.toolName } : {}),
    ...(ctx.payload && typeof ctx.payload === 'object' && !Array.isArray(ctx.payload)
      ? { payload: ctx.payload as Record<string, unknown> }
      : {}),
  }
}
