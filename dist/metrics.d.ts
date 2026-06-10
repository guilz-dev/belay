import type { AuditMetricsReport } from './core/audit-metrics.js';
export interface MetricsOptions {
    targetDir?: string;
    json?: boolean;
}
export declare function metricsProject(options?: MetricsOptions): Promise<AuditMetricsReport>;
export declare function formatMetricsReport(report: AuditMetricsReport): string;
