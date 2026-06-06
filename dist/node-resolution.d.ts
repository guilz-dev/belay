export interface NodeResolutionResult {
    ok: boolean;
    detail: string;
    path?: string;
}
export declare function resolveNodeBinary(): NodeResolutionResult;
export declare function buildRunnerScript(defaultNodePath: string): string;
export declare function buildWindowsRunnerScript(defaultNodePath: string): string;
