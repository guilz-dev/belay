import type { ClassifyResult } from './core/types.js';
import type { ExplainOptions } from './types.js';
export declare function explainCommand(options: ExplainOptions): Promise<{
    repoRoot: string;
    kind: string;
    command: string;
    cwd: string;
    result: ClassifyResult;
}>;
export declare function formatExplainReport(report: Awaited<ReturnType<typeof explainCommand>>): string;
