import type { RecoverOptions, RecoverReport } from '../types.js';
export declare function recoverProject(options?: RecoverOptions): Promise<RecoverReport>;
export declare function formatRecoverReport(report: RecoverReport): string;
