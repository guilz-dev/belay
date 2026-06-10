import type { ApprovalRecord, ApprovalStateFile } from './types.js';
export declare function nowIso(): string;
export declare function isExpired(approval: ApprovalRecord): boolean;
export declare function compactApprovals(state: ApprovalStateFile): ApprovalStateFile;
export declare function mergeApprovalStates(target: ApprovalStateFile, source: ApprovalStateFile): ApprovalStateFile;
export declare function escapeRegex(value: string): string;
export declare function approvalCommandMatch(prompt: string, tokenPrefix: string): string | null;
export declare function buildRetryInstruction(tokenPrefix: string, approvalId: string): string;
export declare function createApprovalRecord(params: {
    kind: ApprovalRecord['kind'];
    fingerprint: string;
    repoRoot: string;
    reason: string;
    summary: string;
    approvalTtlMinutes: number;
    approvalId: string;
}): ApprovalRecord;
