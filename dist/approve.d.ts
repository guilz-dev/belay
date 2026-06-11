import type { EgressApprovalScope } from './core/egress/types.js';
export interface ApproveOptions {
    targetDir?: string;
    approvalId: string;
    token?: string;
    scope?: EgressApprovalScope;
}
export declare function approvePending(options: ApproveOptions): Promise<{
    ok: boolean;
    message: string;
}>;
