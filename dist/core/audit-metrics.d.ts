import { buildApprovalRoundTrips, filterAuditRecords, toAuditRecord } from './audit-query.js';
/** Minimum gate events before recommending enforce with zero would-block rate. */
export declare const MIN_GATE_EVENTS_FOR_ENFORCE = 20;
export interface AuditMetricsReport {
    schemaVersion: number;
    auditLogPath: string;
    totalLines: number;
    parsedRecords: number;
    gateEvents: number;
    wouldBlockCount: number;
    wouldBlockRate: number;
    byReason: Record<string, number>;
    byKind: Record<string, number>;
    byVerdict: Record<string, number>;
    approvalRecordedCount: number;
    topWouldBlockSummaries: Array<{
        summary: string;
        reason: string;
        count: number;
    }>;
    approvalLatency: {
        count: number;
        medianMs: number | null;
        p95Ms: number | null;
    };
    gateEventsByDay: Record<string, number>;
    bypassAttemptCount: number;
    noisyRuleCandidates: Array<{
        reason: string;
        denyCount: number;
        approvedCount: number;
        approvalRate: number;
    }>;
    dogfood: {
        mode: string | null;
        unknownLocalEffect: string | null;
        readyForEnforce: boolean;
        notes: string[];
    };
}
export declare function parseAuditNdjson(raw: string): Record<string, unknown>[];
export declare function computeAuditMetrics(records: Record<string, unknown>[], options?: {
    auditLogPath?: string;
    mode?: string;
    unknownLocalEffect?: string;
}): AuditMetricsReport;
export { buildApprovalRoundTrips, filterAuditRecords, toAuditRecord };
