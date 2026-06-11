import type { ApprovalRoundTrip, AuditFilter, AuditRecord } from './audit-types.js';
export declare function toAuditRecord(value: Record<string, unknown>): AuditRecord;
export declare function parseTimestamp(value?: string): number | null;
export declare function isGateRecord(record: AuditRecord): boolean;
export declare function isApprovalRecorded(record: AuditRecord): boolean;
export declare function inferWouldBlock(record: AuditRecord): boolean;
export declare function filterAuditRecords(records: AuditRecord[], filter?: AuditFilter): AuditRecord[];
export declare function buildApprovalRoundTrips(records: AuditRecord[]): ApprovalRoundTrip[];
export declare function summarizeRoundTrips(trips: ApprovalRoundTrip[]): string[];
