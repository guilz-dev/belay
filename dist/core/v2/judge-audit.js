export function judgeTraceAuditFields(trace) {
    if (!trace) {
        return {};
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
    };
}
