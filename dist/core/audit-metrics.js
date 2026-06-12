import { bucketGateEventsByDay, computeApprovalLatencyStats, countVerdicts, detectBypassAttempts, detectNoisyRules, } from './audit-analysis.js';
import { buildApprovalRoundTrips, filterAuditRecords, inferWouldBlock, isApprovalRecorded, toAuditRecord, } from './audit-query.js';
import { AUDIT_METRICS_SCHEMA_VERSION, GATE_EVENTS } from './audit-types.js';
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
export function computeAuditMetrics(records, options = {}) {
    const auditRecords = records.map(toAuditRecord);
    const byReason = {};
    const byKind = {};
    const byLocation = {};
    const byOpacity = {};
    const byEffect = {};
    const byConfidence = {};
    const summaryCounts = new Map();
    let gateEvents = 0;
    let wouldBlockCount = 0;
    let approvalRecordedCount = 0;
    for (const record of auditRecords) {
        const event = typeof record.event === 'string' ? record.event : '';
        if (isApprovalRecorded(record)) {
            approvalRecordedCount += 1;
            continue;
        }
        if (!GATE_EVENTS.has(event)) {
            continue;
        }
        gateEvents += 1;
        const reason = typeof record.reason === 'string' ? record.reason : 'unknown';
        const kind = typeof record.kind === 'string' ? record.kind : 'unknown';
        increment(byReason, reason);
        increment(byKind, kind);
        if (typeof record.location === 'string') {
            increment(byLocation, record.location);
        }
        if (typeof record.opacity === 'string') {
            increment(byOpacity, record.opacity);
        }
        if (typeof record.effect === 'string') {
            increment(byEffect, record.effect);
        }
        if (typeof record.confidence === 'string') {
            increment(byConfidence, record.confidence);
        }
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
    const byVerdict = countVerdicts(auditRecords);
    const roundTrips = buildApprovalRoundTrips(auditRecords);
    const approvalLatency = computeApprovalLatencyStats(roundTrips);
    const bypassAttempts = detectBypassAttempts(auditRecords);
    const noisyRuleCandidates = detectNoisyRules(auditRecords, roundTrips);
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
    if (noisyRuleCandidates.length > 0) {
        notes.push(`${noisyRuleCandidates.length} noisy rule candidate(s) — high deny-then-approve rate.`);
    }
    return {
        schemaVersion: AUDIT_METRICS_SCHEMA_VERSION,
        auditLogPath: options.auditLogPath ?? 'belay/audit.ndjson',
        totalLines: records.length,
        parsedRecords: records.length,
        gateEvents,
        wouldBlockCount,
        wouldBlockRate,
        byReason,
        byKind,
        byVerdict,
        byLocation,
        byOpacity,
        byEffect,
        byConfidence,
        approvalRecordedCount,
        topWouldBlockSummaries,
        approvalLatency,
        gateEventsByDay: bucketGateEventsByDay(auditRecords),
        bypassAttemptCount: bypassAttempts.length,
        noisyRuleCandidates,
        dogfood: {
            mode,
            unknownLocalEffect,
            readyForEnforce,
            notes,
        },
    };
}
export { buildApprovalRoundTrips, filterAuditRecords, toAuditRecord };
