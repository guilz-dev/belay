const GATE_EVENTS = new Set(['beforeShellExecution', 'preToolUse', 'subagentGate']);
/** Minimum gate events before recommending enforce with zero would-block rate. */
export const MIN_GATE_EVENTS_FOR_ENFORCE = 20;
export function parseAuditNdjson(raw) {
    const records = [];
    for (const line of raw.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed) {
            continue;
        }
        try {
            records.push(JSON.parse(trimmed));
        }
        catch {
            // skip malformed lines
        }
    }
    return records;
}
function increment(bucket, key) {
    bucket[key] = (bucket[key] ?? 0) + 1;
}
function inferWouldBlock(record) {
    if (typeof record.wouldBlock === 'boolean') {
        return record.wouldBlock;
    }
    return record.verdict === 'deny_pending_approval';
}
export function computeAuditMetrics(records, options = {}) {
    const byReason = {};
    const byKind = {};
    const byVerdict = {};
    const summaryCounts = new Map();
    let gateEvents = 0;
    let wouldBlockCount = 0;
    let approvalRecordedCount = 0;
    for (const record of records) {
        const event = typeof record.event === 'string' ? record.event : '';
        if (event === 'beforeSubmitPrompt' && record.reason === 'approval_recorded') {
            approvalRecordedCount += 1;
            continue;
        }
        if (!GATE_EVENTS.has(event)) {
            continue;
        }
        gateEvents += 1;
        const reason = typeof record.reason === 'string' ? record.reason : 'unknown';
        const kind = typeof record.kind === 'string' ? record.kind : 'unknown';
        const verdict = typeof record.verdict === 'string' ? record.verdict : 'unknown';
        increment(byReason, reason);
        increment(byKind, kind);
        increment(byVerdict, verdict);
        if (inferWouldBlock(record)) {
            wouldBlockCount += 1;
            const summary = typeof record.summary === 'string' ? record.summary : '';
            const key = `${reason}::${summary}`;
            const existing = summaryCounts.get(key);
            if (existing) {
                existing.count += 1;
            }
            else {
                summaryCounts.set(key, { summary, reason, count: 1 });
            }
        }
    }
    const wouldBlockRate = gateEvents > 0 ? wouldBlockCount / gateEvents : 0;
    const topWouldBlockSummaries = [...summaryCounts.values()]
        .sort((left, right) => right.count - left.count)
        .slice(0, 10);
    const mode = options.mode ?? null;
    const unknownLocalEffect = options.unknownLocalEffect ?? null;
    const notes = [];
    let readyForEnforce = false;
    if (mode === 'audit' && unknownLocalEffect === 'deny') {
        notes.push('Dogfood config detected: audit mode with fail-closed shell policy.');
        if (gateEvents === 0) {
            notes.push('No gate events yet — run normal agent work, then re-check metrics.');
        }
        else if (wouldBlockRate === 0) {
            if (gateEvents >= MIN_GATE_EVENTS_FOR_ENFORCE) {
                readyForEnforce = true;
                notes.push('No would-block events recorded — safe to try mode: "enforce".');
            }
            else {
                notes.push(`Only ${gateEvents} gate event(s) recorded — collect at least ${MIN_GATE_EVENTS_FOR_ENFORCE} before enforce.`);
            }
        }
        else {
            notes.push(`${wouldBlockCount} would-block event(s) (${(wouldBlockRate * 100).toFixed(1)}% of gate traffic). Review top summaries and add overrides.allow where appropriate.`);
            if (approvalRecordedCount > 0) {
                notes.push(`${approvalRecordedCount} approval(s) recorded — these likely indicate actions operators wanted.`);
            }
            else {
                notes.push('Review top would-block summaries and add overrides.allow for legitimate commands before switching to enforce.');
            }
            if (wouldBlockRate < 0.05 && gateEvents >= 20) {
                readyForEnforce = true;
                notes.push('Would-block rate is below 5% with sufficient sample size — consider enforce mode.');
            }
        }
    }
    else if (mode !== 'audit') {
        notes.push('Config is not in audit mode — metrics show enforce-time behavior.');
    }
    else {
        notes.push('Set policy.unknownLocalEffect to "deny" to dogfood fail-closed defaults.');
    }
    return {
        auditLogPath: options.auditLogPath ?? '.cursor/belay/audit.ndjson',
        totalLines: records.length,
        parsedRecords: records.length,
        gateEvents,
        wouldBlockCount,
        wouldBlockRate,
        byReason,
        byKind,
        byVerdict,
        approvalRecordedCount,
        topWouldBlockSummaries,
        dogfood: {
            mode,
            unknownLocalEffect,
            readyForEnforce,
            notes,
        },
    };
}
