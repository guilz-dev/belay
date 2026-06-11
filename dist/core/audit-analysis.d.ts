import type { ApprovalRoundTrip, AuditRecord, BypassAttempt, NoisyRuleCandidate } from './audit-types.js';
export declare function detectBypassAttempts(records: AuditRecord[], windowMs?: number): BypassAttempt[];
export declare function detectNoisyRules(records: AuditRecord[], roundTrips: ApprovalRoundTrip[], minDenies?: number): NoisyRuleCandidate[];
export declare function computeApprovalLatencyStats(roundTrips: ApprovalRoundTrip[]): {
    count: number;
    medianMs: number | null;
    p95Ms: number | null;
};
export declare function bucketGateEventsByDay(records: AuditRecord[]): Record<string, number>;
export declare function countVerdicts(records: AuditRecord[]): Record<string, number>;
