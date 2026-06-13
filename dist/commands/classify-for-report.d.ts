import type { ClassifyForReportResult, ExplainKind } from '../types.js';
export declare function classifyForReport(params: {
    targetDir?: string;
    cwd?: string;
    kind?: ExplainKind;
    command?: string;
    toolName?: string;
    payload?: Record<string, unknown>;
}): Promise<ClassifyForReportResult>;
