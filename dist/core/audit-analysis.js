import { inferWouldBlock, isGateRecord, parseTimestamp } from './audit-query.js';
const WRAPPER_TERMS = ['bash -c', 'sh -c', 'eval ', 'source ', 'node -e', '| bash', '| sh'];
function normalizeSummary(summary) {
    return summary.replace(/\s+/g, ' ').trim().toLowerCase();
}
function tokenOverlap(left, right) {
    const leftTokens = new Set(normalizeSummary(left).split(' ').filter(Boolean));
    const rightTokens = new Set(normalizeSummary(right).split(' ').filter(Boolean));
    if (leftTokens.size === 0 || rightTokens.size === 0) {
        return 0;
    }
    let overlap = 0;
    for (const token of leftTokens) {
        if (rightTokens.has(token)) {
            overlap += 1;
        }
    }
    return overlap / Math.max(leftTokens.size, rightTokens.size);
}
function hasWrapperPattern(summary) {
    const normalized = normalizeSummary(summary);
    return WRAPPER_TERMS.some((term) => normalized.includes(term));
}
export function detectBypassAttempts(records, windowMs = 5 * 60_000) {
    const attempts = [];
    const recentDenies = [];
    for (const record of records) {
        const timestampMs = parseTimestamp(record.timestamp) ?? 0;
        if (isGateRecord(record) && inferWouldBlock(record) && record.fingerprint) {
            recentDenies.push({ timestampMs, record });
            continue;
        }
        if (!isGateRecord(record) || inferWouldBlock(record)) {
            continue;
        }
        const summary = record.summary ?? '';
        const fingerprint = record.fingerprint ?? '';
        for (const deny of recentDenies) {
            if (timestampMs - deny.timestampMs > windowMs) {
                continue;
            }
            if (deny.record.fingerprint === fingerprint) {
                continue;
            }
            const denySummary = deny.record.summary ?? '';
            const similarity = tokenOverlap(denySummary, summary);
            if (similarity >= 0.6 || hasWrapperPattern(summary)) {
                attempts.push({
                    afterDenyTimestamp: deny.record.timestamp ?? '',
                    denyFingerprint: deny.record.fingerprint ?? '',
                    denySummary,
                    attemptTimestamp: record.timestamp ?? '',
                    attemptSummary: summary,
                    attemptFingerprint: fingerprint,
                    signal: hasWrapperPattern(summary) ? 'wrapper_pattern' : 'similar_command',
                });
            }
        }
    }
    for (const record of records) {
        const signals = record.assessment?.signals ?? [];
        if (!signals.includes('agent_assessment_mismatch')) {
            continue;
        }
        attempts.push({
            afterDenyTimestamp: record.timestamp ?? '',
            denyFingerprint: record.fingerprint ?? '',
            denySummary: record.summary ?? '',
            attemptTimestamp: record.timestamp ?? '',
            attemptSummary: record.summary ?? '',
            attemptFingerprint: record.fingerprint ?? '',
            signal: 'agent_assessment_mismatch',
        });
    }
    return attempts;
}
export function detectNoisyRules(records, roundTrips, minDenies = 2) {
    const denyByReason = new Map();
    const approvedByReason = new Map();
    for (const record of records) {
        if (!isGateRecord(record) || !inferWouldBlock(record)) {
            continue;
        }
        const reason = record.reason ?? 'unknown';
        denyByReason.set(reason, (denyByReason.get(reason) ?? 0) + 1);
    }
    for (const trip of roundTrips) {
        if (!trip.approvalTimestamp) {
            continue;
        }
        approvedByReason.set(trip.reason, (approvedByReason.get(trip.reason) ?? 0) + 1);
    }
    const candidates = [];
    for (const [reason, denyCount] of denyByReason) {
        if (denyCount < minDenies) {
            continue;
        }
        const approvedCount = approvedByReason.get(reason) ?? 0;
        const approvalRate = denyCount > 0 ? approvedCount / denyCount : 0;
        if (approvalRate >= 0.5) {
            candidates.push({ reason, denyCount, approvedCount, approvalRate });
        }
    }
    return candidates.sort((left, right) => right.approvalRate - left.approvalRate);
}
export function computeApprovalLatencyStats(roundTrips) {
    const latencies = roundTrips
        .map((trip) => trip.approvalLatencyMs)
        .filter((value) => typeof value === 'number' && value >= 0)
        .sort((left, right) => left - right);
    if (latencies.length === 0) {
        return { count: 0, medianMs: null, p95Ms: null };
    }
    const medianIndex = Math.floor(latencies.length / 2);
    const p95Index = Math.min(latencies.length - 1, Math.ceil(latencies.length * 0.95) - 1);
    return {
        count: latencies.length,
        medianMs: latencies[medianIndex] ?? null,
        p95Ms: latencies[p95Index] ?? null,
    };
}
export function bucketGateEventsByDay(records) {
    const buckets = {};
    for (const record of records) {
        if (!isGateRecord(record)) {
            continue;
        }
        const timestampMs = parseTimestamp(record.timestamp);
        if (timestampMs === null) {
            continue;
        }
        const day = new Date(timestampMs).toISOString().slice(0, 10);
        buckets[day] = (buckets[day] ?? 0) + 1;
    }
    return buckets;
}
export function countVerdicts(records) {
    const counts = {};
    for (const record of records) {
        if (!isGateRecord(record)) {
            continue;
        }
        const verdict = record.verdict ?? 'unknown';
        counts[verdict] = (counts[verdict] ?? 0) + 1;
    }
    return counts;
}
