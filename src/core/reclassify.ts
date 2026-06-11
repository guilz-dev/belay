import type { AuditRecord } from './audit-types.js'
import { GATE_EVENTS } from './audit-types.js'
import type { BelayConfigV3 } from './config.js'
import { classifierOptionsFromConfig } from './config.js'
import { classifyGatedAction, normalizeGatedAction } from './gate-engine.js'
import type { ClassifyResult } from './types.js'

export interface ReclassifyDiff {
  timestamp?: string
  event?: string
  summary?: string
  fingerprint?: string
  previousVerdict: string
  previousReason: string
  nextVerdict: string
  nextReason: string
}

function shellCommandFromSummary(summary: string): string | null {
  const trimmed = summary.trim()
  return trimmed || null
}

export function reclassifyAuditRecord(
  record: AuditRecord,
  config: BelayConfigV3,
  repoRoot: string,
): ClassifyResult | null {
  if (!record.event || !GATE_EVENTS.has(record.event)) {
    return null
  }

  const kind = record.kind === 'tool' || record.kind === 'subagent' ? record.kind : 'shell'
  const summary = record.summary ?? ''

  try {
    if (kind === 'shell') {
      const command = shellCommandFromSummary(summary)
      if (!command) {
        return null
      }
      const action = normalizeGatedAction({
        kind: 'shell',
        repoRoot,
        cwd: repoRoot,
        command,
      })
      return classifyGatedAction(action, config, classifierOptionsFromConfig(config))
    }

    if (kind === 'subagent') {
      const action = normalizeGatedAction({
        kind: 'subagent',
        repoRoot,
        cwd: repoRoot,
        payload: {
          tool_name: 'Task',
          tool_input: { description: summary },
        },
      })
      return classifyGatedAction(action, config, classifierOptionsFromConfig(config))
    }

    const action = normalizeGatedAction({
      kind: 'tool',
      repoRoot,
      cwd: repoRoot,
      toolName: 'Shell',
      payload: {
        tool_name: 'Shell',
        tool_input: { command: summary },
      },
    })
    return classifyGatedAction(action, config, classifierOptionsFromConfig(config))
  } catch {
    return null
  }
}

export function diffReclassification(
  record: AuditRecord,
  config: BelayConfigV3,
  repoRoot: string,
): ReclassifyDiff | null {
  const next = reclassifyAuditRecord(record, config, repoRoot)
  if (!next) {
    return null
  }
  const previousVerdict = record.verdict ?? 'unknown'
  const previousReason = record.reason ?? 'unknown'
  if (previousVerdict === next.verdict && previousReason === next.reason) {
    return null
  }
  return {
    timestamp: record.timestamp,
    event: record.event,
    summary: record.summary,
    fingerprint: record.fingerprint,
    previousVerdict,
    previousReason,
    nextVerdict: next.verdict,
    nextReason: next.reason,
  }
}
