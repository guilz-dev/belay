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

export interface ReplayActionLike {
  cwd?: string
  kind?: string
  command?: string
  toolName?: string
  payload?: Record<string, unknown>
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
    replayKind === 'shell' || replayKind === 'tool' || replayKind === 'subagent'
      ? replayKind
      : kind
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
