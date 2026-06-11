import path from 'node:path';
import { belayStateDir, countExpiredPending, loadApprovalState, loadConfigFile, pendingApprovalsPath, } from './config-io.js';
import { compactApprovals } from './core/approval.js';
import { loadOperationalInsights } from './operational-insights.js';
export async function statusProject(options = {}) {
    const repoRoot = path.resolve(options.targetDir ?? process.cwd());
    const config = await loadConfigFile(repoRoot);
    const pendingRaw = await loadApprovalState(repoRoot, 'pending-approvals.json', config);
    const approvedRaw = await loadApprovalState(repoRoot, 'approved-approvals.json', config);
    const expiredPendingCount = countExpiredPending(pendingRaw);
    const operational = await loadOperationalInsights({ targetDir: repoRoot });
    return {
        repoRoot,
        approvalStateDir: belayStateDir(config, repoRoot),
        pending: compactApprovals(pendingRaw).approvals,
        approved: compactApprovals(approvedRaw).approvals,
        expiredPendingCount,
        dogfood: operational.dogfood,
        oq3Spike: operational.oq3Spike,
    };
}
export function formatStatusReport(report) {
    const lines = [
        `agent-belay status for ${report.repoRoot}`,
        `Approval state: ${report.approvalStateDir}`,
        `Pending: ${report.pending.length}`,
        `Approved (awaiting use): ${report.approved.length}`,
        `Expired pending (not yet compacted): ${report.expiredPendingCount}`,
        `Dogfood: ${report.dogfood.active ? 'active' : 'inactive'} (mode=${report.dogfood.mode}, unknownLocalEffect=${report.dogfood.unknownLocalEffect})`,
        `Metrics: ${report.dogfood.gateEvents} gate events, ${report.dogfood.wouldBlockCount} would-block (${(report.dogfood.wouldBlockRate * 100).toFixed(1)}%)`,
        `Ready for enforce: ${report.dogfood.readyForEnforce ? 'yes' : 'not yet'}`,
    ];
    if (report.oq3Spike) {
        lines.push(`OQ3 spike: ${report.oq3Spike.ok ? 'ok' : 'failed'} at ${report.oq3Spike.path}`);
    }
    else if (report.dogfood.spikeOnPrompt) {
        lines.push('OQ3 spike: pending — submit a chat prompt in Cursor.');
    }
    lines.push('');
    if (report.pending.length === 0 && report.approved.length === 0) {
        lines.push('No active approvals.');
        return `${lines.join('\n')}\n`;
    }
    if (report.pending.length > 0) {
        lines.push('Pending approvals:');
        for (const approval of report.pending) {
            lines.push(`- ${approval.approvalId} [${approval.kind}] ${approval.reason} — expires ${approval.expiresAt}`);
        }
        lines.push('');
    }
    if (report.approved.length > 0) {
        lines.push('Approved (one-shot, not yet consumed):');
        for (const approval of report.approved) {
            lines.push(`- ${approval.approvalId} [${approval.kind}] ${approval.reason} — expires ${approval.expiresAt}`);
        }
    }
    return `${lines.join('\n')}\n`;
}
export { pendingApprovalsPath };
