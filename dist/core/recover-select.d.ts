import type { AuditRecord } from './audit-types.js';
import type { RecoverTargetInput } from './recover-advice.js';
export interface RecoverSelectOptions {
    since?: string;
    fingerprint?: string;
    limit?: number;
}
export declare function recoverCandidatePriority(record: AuditRecord): number;
export declare function recordToRecoverTarget(record: AuditRecord): RecoverTargetInput;
export declare function selectRecoverTarget(records: AuditRecord[], options?: RecoverSelectOptions): RecoverTargetInput | null;
