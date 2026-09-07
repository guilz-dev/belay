import { getAdapter } from '../adapters/registry.js'
import { repoShellClassifierOptions } from '../adapters/shared/gate-runtime.js'
import { detectAdapterName } from '../config-io.js'
import {
  type AuditActionSnapshot,
  type AuditReplayContext,
  hashReplayPayload,
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
  snapshot: ReturnType<typeof parseAuditActionSnapshot>,
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

function toolPayloadFromV2Snapshot(
  snapshot: Extract<AuditActionSnapshot, { schemaVersion: 2 }>,
): Record<string, unknown> {
  const toolName = snapshot.toolName ?? 'Tool'
  const action = snapshot.action
  if (action.type === 'shell') {
    return { tool_name: toolName, tool_input: { command: action.command } }
  }
  if (action.type === 'file') {
    if (action.operation === 'write') {
      return { tool_name: toolName, tool_input: { file_path: action.path, contents: '' } }
    }
    if (action.operation === 'delete') {
      return { tool_name: 'Delete', tool_input: { path: action.path } }
    }
    return { tool_name: toolName, tool_input: { file_path: action.path } }
  }
  if (action.type === 'patch') {
    const lines = action.targets.map(
      (target) =>
        `*** ${target.operation[0]?.toUpperCase()}${target.operation.slice(1)} File: ${target.path}`,
    )
    return {
      tool_name: toolName,
      tool_input: { patch: ['*** Begin Patch', ...lines, '*** End Patch'].join('\n') },
    }
  }
  if (action.type === 'search') {
    return { tool_name: toolName, tool_input: { pattern: '' } }
  }
  return { tool_name: toolName, tool_input: {} }
}

export async function reclassifyAuditRecord(
  record: AuditRecord,
  config: BelayConfigV3,
  repoRoot: string,
): Promise<ClassifyResult | null> {
  if (!record.event || !GATE_EVENTS.has(record.event)) {
    return null
  }

  const snapshot = parseAuditActionSnapshot(record)
  const replay = trustedReplayContext(snapshot, parseAuditReplayContext(record))
  const kind =
    snapshot?.kind ??
    replay?.kind ??
    (record.kind === 'tool' || record.kind === 'subagent' ? record.kind : 'shell')
  const summary = record.summary ?? ''
  const cwd = snapshot?.cwd ?? replay?.cwd ?? repoRoot

  try {
    if (kind === 'shell') {
      const command =
        (snapshot?.schemaVersion === 2 && snapshot.action.type === 'shell'
          ? snapshot.action.command
          : snapshot?.schemaVersion === 1
            ? snapshot.normalizedAction
            : undefined) ??
        replay?.command ??
        shellCommandFromSummary(summary)
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
        replay?.payload ??
        (snapshot?.schemaVersion === 2 && snapshot.action.type === 'subagent'
          ? {
              tool_name: snapshot.action.subagentType,
              tool_input: {
                description: snapshot.action.externalIntent ? 'deploy' : 'review',
              },
            }
          : ({
              tool_name: 'Task',
              tool_input: { description: summary },
            } as Record<string, unknown>))
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
      replay?.payload ??
      (snapshot?.schemaVersion === 2
        ? toolPayloadFromV2Snapshot(snapshot)
        : ({
            tool_name: toolName,
            tool_input: {
              command: snapshot?.normalizedAction ?? replay?.command ?? summary,
            },
          } as Record<string, unknown>))
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
