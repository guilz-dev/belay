import { createHash } from 'node:crypto'

import type { JudgeTrace } from './types.js'

export function hashJudgeSessionRef(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 16)
}

export function judgeTraceAuditFields(trace?: JudgeTrace): Record<string, unknown> {
  if (!trace) {
    return {}
  }
  return {
    judgeProvider: trace.provider,
    judgeModelRequested: trace.modelRequested,
    judgeModelResolved: trace.modelResolved,
    judgeLatencyMs: trace.latencyMs,
    ...(trace.outboundRedacted !== undefined
      ? { judgeOutboundRedacted: trace.outboundRedacted }
      : {}),
    ...(trace.judgeFallbackReason
      ? { judgeFallbackReason: trace.judgeFallbackReason }
      : trace.fallbackReason
        ? { judgeFallbackReason: trace.fallbackReason }
        : {}),
    ...(trace.judgeSessionUsed !== undefined ? { judgeSessionUsed: trace.judgeSessionUsed } : {}),
    ...(trace.judgeSessionReused !== undefined
      ? { judgeSessionReused: trace.judgeSessionReused }
      : {}),
    ...(trace.judgeSessionRefHash ? { judgeSessionRefHash: trace.judgeSessionRefHash } : {}),
    ...(trace.judgeSessionResetReason
      ? { judgeSessionResetReason: trace.judgeSessionResetReason }
      : {}),
    ...(trace.judgeConnectMs !== undefined ? { judgeConnectMs: trace.judgeConnectMs } : {}),
    ...(trace.judgeEvalMs !== undefined ? { judgeEvalMs: trace.judgeEvalMs } : {}),
    ...(trace.judgeParseMs !== undefined ? { judgeParseMs: trace.judgeParseMs } : {}),
    ...(trace.judgeShadowCompared !== undefined
      ? { judgeShadowCompared: trace.judgeShadowCompared }
      : {}),
    ...(trace.judgeShadowMismatch !== undefined
      ? { judgeShadowMismatch: trace.judgeShadowMismatch }
      : {}),
    ...(trace.judgeShadowMismatchRateWindow !== undefined
      ? { judgeShadowMismatchRateWindow: trace.judgeShadowMismatchRateWindow }
      : {}),
    ...(trace.judgeKillSwitchTriggered !== undefined
      ? { judgeKillSwitchTriggered: trace.judgeKillSwitchTriggered }
      : {}),
  }
}
