import path from 'node:path';
import { approvedApprovalsPath, loadApprovalState, loadConfigFile, pendingApprovalsPath, saveApprovalState, } from './config-io.js';
import { recordApproval } from './core/approval-service.js';
export async function approvePending(options) {
    const repoRoot = path.resolve(options.targetDir ?? process.cwd());
    const config = await loadConfigFile(repoRoot);
    const result = await recordApproval({
        approvalId: options.approvalId,
        config,
        token: options.token,
        store: {
            async loadPending() {
                const filePath = pendingApprovalsPath(repoRoot, config);
                return { filePath, state: await loadApprovalState(repoRoot, 'pending-approvals.json', config) };
            },
            async loadApproved() {
                const filePath = approvedApprovalsPath(repoRoot, config);
                return { filePath, state: await loadApprovalState(repoRoot, 'approved-approvals.json', config) };
            },
            async writePending(_filePath, state) {
                await saveApprovalState(repoRoot, 'pending-approvals.json', state, config);
            },
            async writeApproved(_filePath, state) {
                await saveApprovalState(repoRoot, 'approved-approvals.json', state, config);
            },
        },
    });
    return { ok: result.ok, message: result.message };
}
