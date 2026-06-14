import type { JudgeTrace } from './types.js'

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
    ...(trace.fallbackReason ? { judgeFallbackReason: trace.fallbackReason } : {}),
  }
}
