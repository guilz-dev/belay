import type { ExplainOptions, ExplainReport } from '../types.js';
export declare function explainCommand(options: ExplainOptions): Promise<ExplainReport>;
export declare function formatExplainReport(report: ExplainReport): string;
