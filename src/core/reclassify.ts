import { getAdapter } from '../adapters/registry.js'
import { repoShellClassifierOptions } from '../adapters/shared/gate-runtime.js'
import { detectAdapterName } from '../config-io.js'
import {
  type AuditReplayContext,
  type AuditReplayNonReplayableReason,
  hashReplayPayload,
  type ParsedAuditActionSnapshot,
  parseAuditActionSnapshot,
  parseAuditReplayContext,
} from './audit-replay-context.js'
import type { AuditRecord } from './audit-types.js'
import { GATE_EVENTS } from './audit-types.js'
import type { BelayConfigV3 } from './config.js'
import { classifyGatedAction, normalizeGatedAction } from './gate-engine.js'
import type { ClassifyResult } from './types.js'

export interface ReclassifyDiff {
  timestamp?: string
  event?: string
  summary?: string
  fingerprint?: string
  replayCwd?: string
  replayKind?: string
  previousVerdict: string
  previousReason: string
  nextVerdict: string
  nextReason: string
  replayStatus?: 'non_replayable'
}

export interface NonReplayableAuditReclassification {
  replayable: false
  sourceSchemaVersion: 2
  kind?: 'shell' | 'tool' | 'subagent'
  cwd?: string
  reason: AuditReplayNonReplayableReason
}

export type AuditReclassificationResult = ClassifyResult | NonReplayableAuditReclassification

function isNonReplayableReclassification(
  result: AuditReclassificationResult,
): result is NonReplayableAuditReclassification {
  return (result as Partial<NonReplayableAuditReclassification>).replayable === false
}

function shellCommandFromSummary(summary: string): string | null {
  const trimmed = summary.trim()
  return trimmed || null
}

function classifierOptionsForRepo(config: BelayConfigV3, repoRoot: string) {
  const adapter = getAdapter(config.adapter ?? detectAdapterName(repoRoot))
  return repoShellClassifierOptions(config, repoRoot, adapter.layout)
}

function trustedReplayContext(
  snapshot: Extract<ParsedAuditActionSnapshot, { replayable: true }> | null,
  replay: AuditReplayContext | null,
): AuditReplayContext | null {
  if (!replay) {
    return null
  }
  if (
    snapshot?.payloadHash &&
    replay.payload &&
    hashReplayPayload(replay.payload) !== snapshot.payloadHash
  ) {
    return { ...replay, payload: undefined }
  }
  return replay
}

function projectedToolPayload(
  snapshot: Extract<ParsedAuditActionSnapshot, { replayable: true }>,
): Record<string, unknown> | null {
  if (snapshot.kind !== 'tool' || !snapshot.operation || !snapshot.path) {
    return null
  }
  if (snapshot.operation === 'delete') {
    return { tool_name: 'Delete', tool_input: { path: snapshot.path } }
  }
  if (snapshot.operation === 'read') {
    return { tool_name: 'Read', tool_input: { file_path: snapshot.path } }
  }
  if (snapshot.operation === 'replace') {
    return {
      tool_name: 'StrReplace',
      tool_input: { path: snapshot.path, old_string: ' ', new_string: ' ' },
    }
  }
  return { tool_name: 'Write', tool_input: { path: snapshot.path, contents: ' ' } }
}

function legacyProjectedPayload(
  kind: 'tool' | 'subagent',
  toolName: string,
  replay: AuditReplayContext | null,
): Record<string, unknown> | undefined {
  if (!replay?.payload) {
    return undefined
  }
  if (typeof replay.payload.tool_name === 'string') {
    return replay.payload
  }
  return {
    tool_name: kind === 'subagent' ? 'Task' : toolName,
    tool_input: replay.payload,
  }
}

export async function reclassifyAuditRecord(
  record: AuditRecord,
  config: BelayConfigV3,
  repoRoot: string,
): Promise<AuditReclassificationResult | null> {
  if (!record.event || !GATE_EVENTS.has(record.event)) {
    return null
  }

  const snapshot = parseAuditActionSnapshot(record)
  if (snapshot && !snapshot.replayable) {
    return snapshot
  }
  const replay = trustedReplayContext(snapshot, parseAuditReplayContext(record))
  const kind =
    snapshot?.kind ??
    replay?.kind ??
    (record.kind === 'tool' || record.kind === 'subagent' ? record.kind : 'shell')
  const summary = record.summary ?? ''
  const cwd = snapshot?.cwd ?? replay?.cwd ?? repoRoot

  try {
    if (kind === 'shell') {
      const command = snapshot?.command ?? replay?.command ?? shellCommandFromSummary(summary)
      if (!command) {
        return null
      }
      const action = normalizeGatedAction({
        kind: 'shell',
        repoRoot,
        cwd,
        command,
      })
      return await classifyGatedAction(action, config, classifierOptionsForRepo(config, repoRoot))
    }

    if (kind === 'subagent') {
      const payload =
        legacyProjectedPayload(
          'subagent',
          snapshot?.toolName ?? replay?.toolName ?? 'Task',
          replay,
        ) ??
        ({
          tool_name: 'Task',
          tool_input: { description: snapshot?.command ?? summary },
        } as Record<string, unknown>)
      const action = normalizeGatedAction({
        kind: 'subagent',
        repoRoot,
        cwd,
        payload,
      })
      return await classifyGatedAction(action, config, classifierOptionsForRepo(config, repoRoot))
    }

    const toolName = snapshot?.toolName ?? replay?.toolName ?? 'Shell'
    const payload =
      (snapshot?.sourceSchemaVersion === 2 ? projectedToolPayload(snapshot) : null) ??
      legacyProjectedPayload('tool', toolName, replay) ??
      ({
        tool_name: toolName,
        tool_input: { command: snapshot?.command ?? replay?.command ?? summary },
      } as Record<string, unknown>)
    const action = normalizeGatedAction({
      kind: 'tool',
      repoRoot,
      cwd,
      toolName,
      payload,
    })
    return await classifyGatedAction(action, config, classifierOptionsForRepo(config, repoRoot))
  } catch {
    return null
  }
}

export async function diffReclassification(
  record: AuditRecord,
  config: BelayConfigV3,
  repoRoot: string,
): Promise<ReclassifyDiff | null> {
  const next = await reclassifyAuditRecord(record, config, repoRoot)
  if (!next) {
    return null
  }
  if (isNonReplayableReclassification(next)) {
    return {
      timestamp: record.timestamp,
      event: record.event,
      summary: record.summary,
      fingerprint: record.fingerprint,
      ...(next.cwd || next.kind ? { replayCwd: next.cwd, replayKind: next.kind } : {}),
      previousVerdict: record.verdict ?? 'unknown',
      previousReason: record.reason ?? 'unknown',
      nextVerdict: 'non_replayable',
      nextReason: next.reason,
      replayStatus: 'non_replayable',
    }
  }
  const previousVerdict = record.verdict ?? 'unknown'
  const previousReason = record.reason ?? 'unknown'
  if (previousVerdict === next.verdict && previousReason === next.reason) {
    return null
  }
  const snapshot = parseAuditActionSnapshot(record)
  const replay = parseAuditReplayContext(record)
  return {
    timestamp: record.timestamp,
    event: record.event,
    summary: record.summary,
    fingerprint: record.fingerprint,
    ...(snapshot || replay
      ? { replayCwd: snapshot?.cwd ?? replay?.cwd, replayKind: snapshot?.kind ?? replay?.kind }
      : {}),
    previousVerdict,
    previousReason,
    nextVerdict: next.verdict,
    nextReason: next.reason,
  }
}

export function countMissingActionSnapshots(records: AuditRecord[]): number {
  return records.filter(
    (record) => record.event && GATE_EVENTS.has(record.event) && !parseAuditActionSnapshot(record),
  ).length
}
