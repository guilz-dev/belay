import type { CapabilityApprovalScope } from './capability/types.js';
import type { BelayConfigV3 } from './config.js';
import type { ApprovalStateFile } from './types.js';
export interface CapabilityApprovalStore {
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
export declare function recordCapabilityApproval(params: {
    approvalId: string;
    config: BelayConfigV3;
    store: CapabilityApprovalStore;
    scope?: CapabilityApprovalScope;
    scopePath?: string;
    token?: string;
    requireSignedToken?: boolean;
}): Promise<{
    ok: boolean;
    message: string;
}>;
