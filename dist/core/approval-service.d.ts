import type { BelayConfigV3 } from './config.js';
import type { ApprovalStateFile } from './types.js';
export interface ApprovalStore {
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
}
export declare function recordApproval(params: {
    approvalId: string;
    config: BelayConfigV3;
    store: ApprovalStore;
    token?: string;
    /** When true, require a signed token (out-of-band CLI path). Editor prompts skip this. */
    requireSignedToken?: boolean;
}): Promise<{
    ok: boolean;
    message: string;
    approval?: ApprovalStateFile['approvals'][number];
}>;
