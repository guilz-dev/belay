import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { loadConfigFile } from './config-io.js';
import { computeAuditMetrics, parseAuditNdjson } from './core/audit-metrics.js';
export async function metricsProject(options = {}) {
    const repoRoot = path.resolve(options.targetDir ?? process.cwd());
    const config = await loadConfigFile(repoRoot);
    const auditLogPath = path.join(repoRoot, config.audit.logPath);
    let raw = '';
    try {
        raw = await readFile(auditLogPath, 'utf8');
    }
    catch {
        raw = '';
    }
    const records = parseAuditNdjson(raw);
    return computeAuditMetrics(records, {
        auditLogPath: config.audit.logPath,
        mode: config.mode,
        unknownLocalEffect: config.policy.unknownLocalEffect,
    });
}
export function formatMetricsReport(report) {
    const lines = [
        `agent-belay metrics for ${report.auditLogPath}`,
        `Gate events: ${report.gateEvents}`,
        `Would-block: ${report.wouldBlockCount} (${(report.wouldBlockRate * 100).toFixed(1)}%)`,
        `Approvals recorded during audit: ${report.approvalRecordedCount}`,
    ];
    if (Object.keys(report.byReason).length > 0) {
        lines.push('', 'By reason:');
        for (const [reason, count] of Object.entries(report.byReason).sort((a, b) => b[1] - a[1])) {
            lines.push(`- ${reason}: ${count}`);
        }
    }
    if (report.topWouldBlockSummaries.length > 0) {
        lines.push('', 'Top would-block summaries:');
        for (const entry of report.topWouldBlockSummaries) {
            lines.push(`- [${entry.reason}] x${entry.count}: ${entry.summary}`);
        }
    }
    if (report.dogfood.notes.length > 0) {
        lines.push('', 'Dogfood notes:');
        for (const note of report.dogfood.notes) {
            lines.push(`- ${note}`);
        }
        lines.push('', report.dogfood.readyForEnforce ? 'Ready for enforce: yes' : 'Ready for enforce: not yet');
    }
    return `${lines.join('\n')}\n`;
}
