import { pendingApprovalsPath } from './config-io.js';
import type { StatusOptions, StatusReport } from './types.js';
export declare function statusProject(options?: StatusOptions): Promise<StatusReport>;
export declare function formatStatusReport(report: StatusReport): string;
export { pendingApprovalsPath };
