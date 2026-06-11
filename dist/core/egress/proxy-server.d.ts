import http from 'node:http';
import type { BelayConfigV3 } from '../config.js';
import { type EgressApprovalStore } from '../egress-approval.js';
import type { ApprovalStateFile } from '../types.js';
export interface EgressProxyContext {
    config: BelayConfigV3;
    repoRoot: string;
    store: EgressApprovalStore;
    onAudit?: (event: Record<string, unknown>) => Promise<void>;
    loadApproved: () => Promise<ApprovalStateFile>;
}
export declare function parseConnectTarget(url: string): {
    host: string;
    port: number;
} | null;
export declare function createEgressProxy(ctx: EgressProxyContext): http.Server;
export declare function startEgressProxy(ctx: EgressProxyContext): Promise<{
    server: http.Server;
    port: number;
    host: string;
}>;
