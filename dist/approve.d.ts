import type { CapabilityApprovalScope } from './core/capability/types.js';
import type { EgressApprovalScope } from './core/egress/types.js';
export type ApproveScope = EgressApprovalScope | CapabilityApprovalScope;
export interface ApproveOptions {
    targetDir?: string;
    approvalId: string;
    token?: string;
    scope?: ApproveScope;
    scopePath?: string;
}
export declare function approvePending(options: ApproveOptions): Promise<{
    ok: boolean;
    message: string;
}>;
