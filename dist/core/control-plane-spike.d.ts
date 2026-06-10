export interface ControlPlaneSpikeResult {
    ok: boolean;
    controlPlaneDir: string;
    testFile: string;
    home: string;
    xdgConfigHome: string | null;
    cwd: string;
    wrote: boolean;
    readBack: string | null;
    error?: string;
}
/**
 * OQ3 spike: verify hook-like Node context can read/write the user control-plane dir.
 * Does not require Cursor; simulates the filesystem access pattern for beforeSubmitPrompt.
 */
export declare function runControlPlaneSpike(env?: NodeJS.ProcessEnv, cwd?: string, homedir?: () => string): Promise<ControlPlaneSpikeResult>;
