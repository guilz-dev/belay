import { loadConfigFile } from './config-io.js';
export interface SandboxServiceOptions {
    targetDir?: string;
}
export interface SandboxStatusReport {
    repoRoot: string;
    sandboxEnabled: boolean;
    sandboxRuntime: string;
    denyNetworkByDefault: boolean;
    brokerActive: boolean;
    fsScopeAllowlistCount: number;
    controlPlaneIsolationMode: string;
    controlPlaneIsolationOk: boolean;
    l1FullActive: boolean;
    l1Full: {
        sandbox: boolean;
        egress: boolean;
        egressProxyRunning: boolean;
        controlPlaneIsolation: boolean;
        approvalSigningRequired: boolean;
    };
    issues: string[];
}
export declare function sandboxStatus(options?: SandboxServiceOptions): Promise<SandboxStatusReport>;
export declare function createCapabilityApprovalStore(repoRoot: string, config: Awaited<ReturnType<typeof loadConfigFile>>): {
    allowlistPath: string;
    loadPending(): Promise<{
        filePath: string;
        state: import("./types.js").ApprovalStateFile;
    }>;
    loadApproved(): Promise<{
        filePath: string;
        state: import("./types.js").ApprovalStateFile;
    }>;
    writePending(_filePath: string, state: import("./core/types.js").ApprovalStateFile): Promise<void>;
    writeApproved(_filePath: string, state: import("./core/types.js").ApprovalStateFile): Promise<void>;
};
export declare function formatSandboxStatusReport(report: SandboxStatusReport): string;
