import path from 'node:path';
import { loadConfigFile } from '../config-io.js';
import { detectFenceDrift, formatAskBreakdown, summarizeAuditVisibility } from '../core/audit-summary.js';
import { loadAuditRecords } from './audit.js';
export async function reportProject(options = {}) {
    const repoRoot = path.resolve(options.targetDir ?? process.cwd());
    const config = await loadConfigFile(repoRoot);
    const auditLogPath = path.join(repoRoot, config.audit.logPath);
    const records = await loadAuditRecords(repoRoot);
    const filter = {
        since: options.since,
        until: options.until,
    };
    const summary = summarizeAuditVisibility(records, filter, {
        recentAskLimit: options.limit ?? 10,
    });
    const drift = detectFenceDrift(summary, {
        threshold: config.policy.fenceWarnThreshold,
    });
    return {
        repoRoot,
        auditLogPath,
        ...summary,
        warnings: drift.warnings,
        notes: drift.notes,
    };
}
export function formatReport(report) {
    const lines = [
        `agent-belay report for ${report.repoRoot}`,
        `Audit log: ${report.auditLogPath}`,
        '',
        `Gate events: ${report.gateEvents}`,
        ...formatAskBreakdown(report),
        `Flag (allow_flagged): ${report.flagCount}`,
        `Allow (silent pass): ${report.allowCount}`,
        `Silent-pass rate: ${(report.silentPassRate * 100).toFixed(1)}%`,
        '',
    ];
    if (report.warnings.length > 0) {
        lines.push('Warnings:');
        for (const warning of report.warnings) {
            lines.push(`- ${warning}`);
        }
        lines.push('');
    }
    if (report.notes.length > 0) {
        lines.push('Notes:');
        for (const note of report.notes) {
            lines.push(`- ${note}`);
        }
        lines.push('');
    }
    if (report.recentAsks.length === 0) {
        lines.push('No recent asks in the selected period.');
    }
    else {
        lines.push('Recent asks:');
        for (const ask of report.recentAsks) {
            const when = ask.timestamp ?? 'unknown-time';
            lines.push(`- [${when}] (${ask.tier}) ${ask.reason} — ${ask.summary}`);
        }
    }
    return `${lines.join('\n')}\n`;
}
