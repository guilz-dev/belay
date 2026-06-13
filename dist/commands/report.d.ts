import type { AuditVisibilityReport, ReportOptions } from '../types.js';
export declare function reportProject(options?: ReportOptions): Promise<AuditVisibilityReport>;
export declare function formatReport(report: AuditVisibilityReport): string;
