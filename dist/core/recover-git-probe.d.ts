export interface GitProbeResult {
    inWorkTree: boolean;
    porcelain?: string;
    reflog?: string;
    notes: string[];
}
export declare function isReadOnlyGitProbe(commandKey: string): boolean;
export declare function probeGitState(repoRoot: string): Promise<GitProbeResult>;
