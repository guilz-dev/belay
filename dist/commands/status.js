import path from 'node:path';
import { belayStateDir, countExpiredPending, loadApprovalState, loadConfigFile, pendingApprovalsPath, repoLocalStateDirFor, } from '../config-io.js';
import { compactApprovals } from '../core/approval.js';
import { loadOperationalInsights } from '../operational-insights.js';
import { collectHealthSnapshot } from './health-snapshot.js';
import { reportProject } from './report.js';
export async function statusProject(options = {}) {
    const repoRoot = path.resolve(options.targetDir ?? process.cwd());
    const config = await loadConfigFile(repoRoot);
    const pendingRaw = await loadApprovalState(repoRoot, 'pending-approvals.json', config);
    const approvedRaw = await loadApprovalState(repoRoot, 'approved-approvals.json', config);
    const expiredPendingCount = countExpiredPending(pendingRaw);
    const operational = await loadOperationalInsights({ targetDir: repoRoot });
    const health = await collectHealthSnapshot({ targetDir: repoRoot, adapter: config.adapter });
    const visibility = await reportProject({ targetDir: repoRoot });
    return {
        repoRoot,
        approvalStateDir: belayStateDir(config, repoLocalStateDirFor(repoRoot, config)),
        pending: compactApprovals(pendingRaw).approvals,
        approved: compactApprovals(approvedRaw).approvals,
        expiredPendingCount,
        dogfood: operational.dogfood,
        health,
        visibility,
    };
}
export function formatStatusReport(report) {
    const { health } = report;
    const lines = [
        `agent-belay status for ${report.repoRoot}`,
        `Adapter: ${health.adapter} (scope=${health.installScope})`,
        `Floor installed: ${health.floorInstalled ? 'yes' : 'no'}`,
        `Skill installed: ${health.skillInstalled ? 'yes' : 'no'}`,
        ...(health.skillOnly
            ? [
                'Skill-only mode: yes — hooks are missing or incomplete. Run `npx agent-belay init` to install the enforcement floor.',
            ]
            : []),
        `Approval state: ${report.approvalStateDir}`,
        `Pending: ${report.pending.length}`,
        `Approved (awaiting use): ${report.approved.length}`,
        `Expired pending (not yet compacted): ${report.expiredPendingCount}`,
        `Dogfood: ${report.dogfood.active ? 'active' : 'inactive'} (mode=${report.dogfood.mode}, unknownLocalEffect=${report.dogfood.unknownLocalEffect})`,
        `Metrics: ${report.dogfood.gateEvents} gate events, ${report.dogfood.wouldBlockCount} would-block (${(report.dogfood.wouldBlockRate * 100).toFixed(1)}%)`,
        `Ready for enforce: ${report.dogfood.readyForEnforce ? 'yes' : 'not yet'}`,
        '',
        'Audit visibility:',
        `  Gate events: ${report.visibility.gateEvents}`,
        `  Ask (would-block): ${report.visibility.askCount}`,
        `  Flag (allow_flagged): ${report.visibility.flagCount}`,
        `  Allow (silent pass): ${report.visibility.allowCount}`,
        `  Silent-pass rate: ${(report.visibility.silentPassRate * 100).toFixed(1)}%`,
        '',
    ];
    if (report.visibility.warnings.length > 0) {
        lines.push('Audit warnings:');
        for (const warning of report.visibility.warnings) {
            lines.push(`- ${warning}`);
        }
        lines.push('');
    }
    if (report.visibility.recentAsks.length > 0) {
        lines.push('Recent asks:');
        for (const ask of report.visibility.recentAsks.slice(0, 5)) {
            const when = ask.timestamp ?? 'unknown-time';
            lines.push(`- [${when}] (${ask.tier}) ${ask.reason} — ${ask.summary}`);
        }
        lines.push('');
    }
    const approvalLines = [];
    if (report.pending.length === 0 && report.approved.length === 0) {
        approvalLines.push('No active approvals.');
    }
    else {
        if (report.pending.length > 0) {
            approvalLines.push('Pending approvals:');
            for (const approval of report.pending) {
                approvalLines.push(`- ${approval.approvalId} [${approval.kind}] ${approval.reason} — expires ${approval.expiresAt}`);
            }
            approvalLines.push('');
        }
        if (report.approved.length > 0) {
            approvalLines.push('Approved (one-shot, not yet consumed):');
            for (const approval of report.approved) {
                approvalLines.push(`- ${approval.approvalId} [${approval.kind}] ${approval.reason} — expires ${approval.expiresAt}`);
            }
        }
    }
    lines.push(...approvalLines);
    return `${lines.join('\n')}\n`;
}
export { pendingApprovalsPath };
