import type { ExplainOptions } from './types.js';
export declare function explainCommand(options: ExplainOptions): Promise<{
    repoRoot: string;
    command: string;
    cwd: string;
    result: import("./types.js").ClassifyResult;
}>;
export declare function formatExplainReport(report: Awaited<ReturnType<typeof explainCommand>>): string;
