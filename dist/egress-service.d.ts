import { loadConfigFile } from './config-io.js';
import { type BelayConfigV3 } from './core/config.js';
import type { ApprovalStateFile } from './core/types.js';
export interface EgressServiceOptions {
    targetDir?: string;
}
export interface EgressStatusReport {
    repoRoot: string;
    enabled: boolean;
    running: boolean;
    host: string;
    port: number;
    pid: number | null;
    startedAt: string | null;
    boundRepoRoot: string | null;
    repoRootMismatch: boolean;
    foreignProxy: boolean;
    portOccupied: boolean;
    proxyEnv: Record<string, string>;
}
export declare function isEgressProxyActiveForRepo(config: BelayConfigV3, repoRoot: string, repoLocalStateDir: string): boolean;
export declare function egressStatus(options?: EgressServiceOptions): Promise<EgressStatusReport>;
export declare function startEgressProxy(options?: EgressServiceOptions): Promise<{
    ok: boolean;
    message: string;
}>;
export declare function stopEgressProxy(options?: EgressServiceOptions): Promise<{
    ok: boolean;
    message: string;
}>;
export declare function egressEnv(options?: EgressServiceOptions): Promise<{
    ok: boolean;
    message: string;
    env: Record<string, string>;
}>;
export declare function formatEgressStatusReport(report: EgressStatusReport): string;
export declare function createEgressApprovalStore(repoRoot: string, config: Awaited<ReturnType<typeof loadConfigFile>>): {
    allowlistPath: string;
    loadPending(): Promise<{
        filePath: string;
        state: ApprovalStateFile;
    }>;
    loadApproved(): Promise<{
        filePath: string;
        state: ApprovalStateFile;
    }>;
    writePending(_filePath: string, state: ApprovalStateFile): Promise<void>;
    writeApproved(_filePath: string, state: ApprovalStateFile): Promise<void>;
};
export declare function writeEgressDaemonState(params: {
    stateDir: string;
    pid: number;
    host: string;
    port: number;
    repoRoot: string;
}): Promise<void>;
export declare function clearEgressDaemonState(stateDir: string): Promise<void>;
