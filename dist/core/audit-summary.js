import { filterAuditRecords, inferWouldBlock, isApprovalRecorded, isGateRecord, parseTimestamp, recordStringField, } from './audit-query.js';
export const DEFAULT_SILENT_PASS_THRESHOLD = 0.5;
export const MIN_GATE_EVENTS_FOR_FENCE_DRIFT = 20;
function isTier0Reason(reason) {
    return reason.startsWith('tier0_') || reason === 'external_effect';
}
export function inferAuditTier(record) {
    const savedConfidence = typeof record.confidence === 'string' ? record.confidence : '';
    const reason = typeof record.reason === 'string' ? record.reason : '';
    if (savedConfidence === 'llm') {
        return 'Tier1';
    }
    if (savedConfidence === 'deterministic') {
        return isTier0Reason(reason) ? 'Tier0' : 'deterministic';
    }
    if (isTier0Reason(reason)) {
        return 'Tier0';
    }
    if (reason === 'unknown_local_effect') {
        return 'Tier1';
    }
    return 'deterministic';
}
export function formatAskBreakdown(summary, indent = '') {
    const lines = [
        `${indent}Ask (would-block): ${summary.askCount}`,
        `${indent}  enforce (blocked): ${summary.enforceAskCount}`,
        `${indent}  audit (would-block only): ${summary.auditAskCount}`,
    ];
    if (summary.unknownModeAskCount > 0) {
        lines.push(`${indent}  mode unknown (legacy): ${summary.unknownModeAskCount}`);
    }
    return lines;
}
function isGateEventRecord(record) {
    return isGateRecord(record) && !isApprovalRecorded(record);
}
export function summarizeAuditVisibility(records, filter = {}, options = {}) {
    const filtered = filterAuditRecords(records, filter);
    const gateRecords = filtered.filter(isGateEventRecord);
    const recentAskLimit = options.recentAskLimit ?? 10;
    let askCount = 0;
    let enforceAskCount = 0;
    let auditAskCount = 0;
    let unknownModeAskCount = 0;
    let flagCount = 0;
    let allowCount = 0;
    const recentAsks = [];
    for (const record of gateRecords) {
        if (inferWouldBlock(record)) {
            askCount += 1;
            const recordMode = recordStringField(record, 'mode');
            if (recordMode === 'enforce') {
                enforceAskCount += 1;
            }
            else if (recordMode === 'audit') {
                auditAskCount += 1;
            }
            else {
                unknownModeAskCount += 1;
            }
            recentAsks.push({
                timestamp: record.timestamp,
                summary: typeof record.summary === 'string' ? record.summary : '',
                reason: typeof record.reason === 'string' ? record.reason : 'unknown',
                tier: inferAuditTier(record),
            });
        }
        if (record.verdict === 'allow_flagged') {
            flagCount += 1;
        }
        if (record.verdict === 'allow') {
            allowCount += 1;
        }
    }
    recentAsks.sort((left, right) => {
        const leftMs = parseTimestamp(left.timestamp) ?? 0;
        const rightMs = parseTimestamp(right.timestamp) ?? 0;
        return rightMs - leftMs;
    });
    const gateEvents = gateRecords.length;
    const silentPassRate = gateEvents > 0 ? (allowCount + flagCount) / gateEvents : 0;
    return {
        gateEvents,
        askCount,
        enforceAskCount,
        auditAskCount,
        unknownModeAskCount,
        flagCount,
        allowCount,
        silentPassRate,
        recentAsks: recentAsks.slice(0, recentAskLimit),
    };
}
export function detectFenceDrift(summary, options = {}) {
    const threshold = options.threshold ?? DEFAULT_SILENT_PASS_THRESHOLD;
    const warnings = [];
    const notes = [];
    if (summary.gateEvents === 0) {
        return { warnings, notes };
    }
    if (summary.gateEvents < MIN_GATE_EVENTS_FOR_FENCE_DRIFT) {
        notes.push(`Fence drift check deferred: only ${summary.gateEvents} gate event(s) recorded (need at least ${MIN_GATE_EVENTS_FOR_FENCE_DRIFT} for a reliable silent-pass rate).`);
        return { warnings, notes };
    }
    if (summary.silentPassRate < threshold) {
        warnings.push(`Silent-pass rate is ${(summary.silentPassRate * 100).toFixed(1)}% (below ${(threshold * 100).toFixed(0)}% threshold). ` +
            'This may indicate over-blocking (fence-like behavior). Use belay explain on recent asks to check for false positives.');
    }
    return { warnings, notes };
}
