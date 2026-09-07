import { createHash } from 'node:crypto'

import type { GatedActionKind } from './gate-contract.js'
import type { ClassifyResult } from './types.js'

/** Preserved action context for simulate triage — not a safety gate. */
export interface AuditReplayContext {
  cwd: string
  kind: GatedActionKind
  command?: string
  toolName?: string
  payload?: Record<string, unknown>
}

/** Classifier-facing action snapshot for high-fidelity simulate replay. */
export interface AuditActionSnapshotV1 {
  schemaVersion: 1
  kind: GatedActionKind
  cwd: string
  normalizedAction: string
  toolName?: string
  payloadHash?: string
}

export type AuditSnapshotActionV2 =
  | { type: 'shell'; command: string }
  | { type: 'file'; operation: 'read' | 'write' | 'delete'; path: string }
  | {
      type: 'patch'
      targets: Array<{ operation: 'add' | 'update' | 'delete'; path: string }>
    }
  | { type: 'search' }
  | { type: 'subagent'; subagentType: string; externalIntent: boolean; summaryHash?: string }
  | { type: 'unknown' }

export interface AuditActionSnapshotV2 {
  schemaVersion: 2
  kind: GatedActionKind
  cwd: string
  toolName?: string
  action: AuditSnapshotActionV2
  payloadHash?: string
}

export type AuditActionSnapshot = AuditActionSnapshotV1 | AuditActionSnapshotV2

export interface ReplayActionLike {
  cwd?: string
  kind?: string
  command?: string
  toolName?: string
  payload?: Record<string, unknown>
}

export function hashReplayPayload(payload: Record<string, unknown>): string {
  return createHash('sha256').update(JSON.stringify(payload)).digest('hex')
}

function stringField(input: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = input[key]
    if (typeof value === 'string' && value.trim()) {
      return value.trim()
    }
  }
  return undefined
}

function patchTargets(patch: string): Array<{
  operation: 'add' | 'update' | 'delete'
  path: string
}> {
  const targets: Array<{ operation: 'add' | 'update' | 'delete'; path: string }> = []
  for (const line of patch.split('\n')) {
    const match = line.match(/^\*\*\* (Add|Update|Delete) File: (.+)$/)
    if (match?.[1] && match[2]) {
      targets.push({
        operation: match[1].toLowerCase() as 'add' | 'update' | 'delete',
        path: match[2],
      })
      continue
    }
    const moveMatch = line.match(/^\*\*\* Move to: (.+)$/)
    if (moveMatch?.[1]) {
      targets.push({ operation: 'update', path: moveMatch[1] })
    }
  }
  return targets
}

function buildToolSnapshotAction(
  toolName: string,
  input: Record<string, unknown>,
): AuditSnapshotActionV2 {
  const command = stringField(input, ['command'])
  if (command) {
    return { type: 'shell', command }
  }

  const patch = stringField(input, ['patch', 'input', 'text'])
  if (patch) {
    const targets = patchTargets(patch)
    if (targets.length > 0) {
      return { type: 'patch', targets }
    }
  }

  const path = stringField(input, ['path', 'file_path', 'target_file', 'filePath'])
  if (path) {
    const normalizedName = toolName.trim().toLowerCase()
    const hasMutationBody = ['contents', 'old_string', 'new_string', 'newContents'].some(
      (key) => typeof input[key] === 'string',
    )
    const operation =
      normalizedName === 'delete'
        ? 'delete'
        : hasMutationBody || typeof input.file_path !== 'string'
          ? 'write'
          : 'read'
    return { type: 'file', operation, path }
  }

  if (typeof input.pattern === 'string' || typeof input.glob_pattern === 'string') {
    return { type: 'search' }
  }
  return { type: 'unknown' }
}

export function buildAuditActionSnapshot(
  kind: GatedActionKind,
  result: Pick<ClassifyResult, 'normalizedCommand' | 'summary'>,
  replayAction?: ReplayActionLike,
): AuditActionSnapshot | undefined {
  if (!replayAction?.cwd) {
    return undefined
  }
  const replayKind = replayAction.kind
  const resolvedKind: GatedActionKind =
    replayKind === 'shell' || replayKind === 'tool' || replayKind === 'subagent' ? replayKind : kind
  const payloadHash = replayAction.payload ? hashReplayPayload(replayAction.payload) : undefined
  if (resolvedKind === 'shell') {
    const command = replayAction.command ?? result.normalizedCommand ?? result.summary ?? ''
    return command.trim()
      ? {
          schemaVersion: 2,
          kind: 'shell',
          cwd: replayAction.cwd,
          action: { type: 'shell', command },
        }
      : undefined
  }
  if (resolvedKind === 'subagent') {
    const input = replayAction.payload ?? {}
    const text = [input.description, input.prompt]
      .filter((value): value is string => typeof value === 'string' && value.length > 0)
      .join(' ')
    const subagentType =
      replayAction.toolName === 'Task' ? 'Task' : (replayAction.toolName ?? 'generalPurpose')
    return {
      schemaVersion: 2,
      kind: 'subagent',
      cwd: replayAction.cwd,
      action: {
        type: 'subagent',
        subagentType,
        externalIntent: /\b(deploy|production|publish|release|ship|notify|email)\b/i.test(text),
        ...(text ? { summaryHash: createHash('sha256').update(text).digest('hex') } : {}),
      },
      ...(payloadHash ? { payloadHash } : {}),
    }
  }

  const toolName = replayAction.toolName ?? 'Tool'
  return {
    schemaVersion: 2,
    kind: 'tool',
    cwd: replayAction.cwd,
    toolName,
    action: buildToolSnapshotAction(toolName, replayAction.payload ?? {}),
    ...(payloadHash ? { payloadHash } : {}),
  }
}

export function parseAuditActionSnapshot(record: {
  actionSnapshot?: unknown
}): AuditActionSnapshot | null {
  const raw = record.actionSnapshot
  if (!raw || typeof raw !== 'object') {
    return null
  }
  const snapshot = raw as Record<string, unknown>
  if (snapshot.schemaVersion === 2) {
    const kind = snapshot.kind
    const action = snapshot.action
    if (
      (kind !== 'shell' && kind !== 'tool' && kind !== 'subagent') ||
      typeof snapshot.cwd !== 'string' ||
      !snapshot.cwd.trim() ||
      !action ||
      typeof action !== 'object' ||
      Array.isArray(action)
    ) {
      return null
    }
    const typedAction = action as AuditSnapshotActionV2
    if (!['shell', 'file', 'patch', 'search', 'subagent', 'unknown'].includes(typedAction.type)) {
      return null
    }
    return {
      schemaVersion: 2,
      kind,
      cwd: snapshot.cwd,
      ...(typeof snapshot.toolName === 'string' ? { toolName: snapshot.toolName } : {}),
      action: typedAction,
      ...(typeof snapshot.payloadHash === 'string' ? { payloadHash: snapshot.payloadHash } : {}),
    }
  }
  if (snapshot.schemaVersion !== 1) {
    return null
  }
  if (typeof snapshot.cwd !== 'string' || !snapshot.cwd.trim()) {
    return null
  }
  const kind = snapshot.kind
  if (kind !== 'shell' && kind !== 'tool' && kind !== 'subagent') {
    return null
  }
  if (typeof snapshot.normalizedAction !== 'string' || !snapshot.normalizedAction.trim()) {
    return null
  }
  return {
    schemaVersion: 1,
    kind,
    cwd: snapshot.cwd,
    normalizedAction: snapshot.normalizedAction,
    ...(typeof snapshot.toolName === 'string' ? { toolName: snapshot.toolName } : {}),
    ...(typeof snapshot.payloadHash === 'string' ? { payloadHash: snapshot.payloadHash } : {}),
  }
}

export function buildAuditReplayContext(
  kind: GatedActionKind,
  _result: Pick<ClassifyResult, 'normalizedCommand' | 'summary'>,
  replayAction?: ReplayActionLike,
): AuditReplayContext | undefined {
  if (!replayAction?.cwd) {
    return undefined
  }
  const replayKind = replayAction.kind
  const resolvedKind: GatedActionKind =
    replayKind === 'shell' || replayKind === 'tool' || replayKind === 'subagent' ? replayKind : kind
  return {
    cwd: replayAction.cwd,
    kind: resolvedKind,
    ...(replayAction.command ? { command: replayAction.command } : {}),
    ...(replayAction.toolName ? { toolName: replayAction.toolName } : {}),
  }
}

export function parseAuditReplayContext(record: {
  replayContext?: unknown
}): AuditReplayContext | null {
  const raw = record.replayContext
  if (!raw || typeof raw !== 'object') {
    return null
  }
  const ctx = raw as Record<string, unknown>
  if (typeof ctx.cwd !== 'string' || !ctx.cwd.trim()) {
    return null
  }
  const kind = ctx.kind
  if (kind !== 'shell' && kind !== 'tool' && kind !== 'subagent') {
    return null
  }
  return {
    cwd: ctx.cwd,
    kind,
    ...(typeof ctx.command === 'string' ? { command: ctx.command } : {}),
    ...(typeof ctx.toolName === 'string' ? { toolName: ctx.toolName } : {}),
  }
}
