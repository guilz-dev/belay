import type { ApprovalStateFile } from '../types.js';
import type { EgressAllowlistFile, EgressConnectRequest, EgressPolicyResult } from './types.js';
export declare function evaluateEgressConnect(params: {
    request: EgressConnectRequest;
    allowlist: EgressAllowlistFile;
    approved: ApprovalStateFile;
    pendingApprovalId?: string;
}): EgressPolicyResult;
