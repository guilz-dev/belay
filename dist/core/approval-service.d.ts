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
}): Promise<{
    ok: boolean;
    message: string;
    approval?: ApprovalStateFile['approvals'][number];
}>;
