import type { AuditRecord } from './audit-types.js';
import type { BelayConfigV3 } from './config.js';
import type { ClassifyResult } from './types.js';
export interface ReclassifyDiff {
    timestamp?: string;
    event?: string;
    summary?: string;
    fingerprint?: string;
    previousVerdict: string;
    previousReason: string;
    nextVerdict: string;
    nextReason: string;
}
export declare function reclassifyAuditRecord(record: AuditRecord, config: BelayConfigV3, repoRoot: string): Promise<ClassifyResult | null>;
export declare function diffReclassification(record: AuditRecord, config: BelayConfigV3, repoRoot: string): Promise<ReclassifyDiff | null>;
