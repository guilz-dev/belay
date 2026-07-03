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
export interface AuditActionSnapshot {
  schemaVersion: 1
  kind: GatedActionKind
  cwd: string
  normalizedAction: string
  toolName?: string
  payloadHash?: string
}

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
  const normalizedAction = result.normalizedCommand ?? replayAction.command ?? result.summary ?? ''
  if (!normalizedAction.trim()) {
    return undefined
  }
  return {
    schemaVersion: 1,
    kind: resolvedKind,
    cwd: replayAction.cwd,
    normalizedAction,
    ...(replayAction.toolName ? { toolName: replayAction.toolName } : {}),
    ...(replayAction.payload ? { payloadHash: hashReplayPayload(replayAction.payload) } : {}),
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
  result: Pick<ClassifyResult, 'normalizedCommand' | 'summary'>,
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
    command: replayAction.command ?? result.normalizedCommand ?? result.summary,
    ...(replayAction.toolName ? { toolName: replayAction.toolName } : {}),
    ...(replayAction.payload ? { payload: replayAction.payload } : {}),
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
    ...(ctx.payload && typeof ctx.payload === 'object' && !Array.isArray(ctx.payload)
      ? { payload: ctx.payload as Record<string, unknown> }
      : {}),
  }
}
