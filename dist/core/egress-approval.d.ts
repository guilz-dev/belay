import type { BelayConfigV3 } from './config.js';
import type { EgressApprovalScope, EgressPolicyResult } from './egress/types.js';
import type { ApprovalRecord, ApprovalStateFile } from './types.js';
export interface EgressApprovalStore {
    loadPending: () => Promise<{
        filePath: string;
        state: ApprovalStateFile;
    }>;
    loadApproved: () => Promise<{
        filePath: string;
        state: ApprovalStateFile;
    }>;
    writePending: (filePath: string, state: ApprovalStateFile) => Promise<void>;
    writeApproved: (filePath: string, state: ApprovalStateFile) => Promise<void>;
    allowlistPath: string;
}
export declare function ensurePendingEgressApproval(params: {
    config: BelayConfigV3;
    repoRoot: string;
    policyResult: EgressPolicyResult;
    store: EgressApprovalStore;
}): Promise<{
    approvalId: string;
    approval: ApprovalRecord;
    created: boolean;
}>;
export declare function consumeApprovedEgress(params: {
    repoRoot: string;
    fingerprint: string;
    store: EgressApprovalStore;
}): Promise<ApprovalRecord | null>;
export declare function notifyEgressDeny(params: {
    config: BelayConfigV3;
    repoRoot: string;
    policyResult: EgressPolicyResult;
    approval: ApprovalRecord;
}): Promise<void>;
export declare function recordEgressApproval(params: {
    approvalId: string;
    config: BelayConfigV3;
    store: EgressApprovalStore;
    scope?: EgressApprovalScope;
    token?: string;
    requireSignedToken?: boolean;
}): Promise<{
    ok: boolean;
    message: string;
}>;
