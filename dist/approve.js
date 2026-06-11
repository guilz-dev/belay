import path from 'node:path';
import { approvedApprovalsPath, loadApprovalState, loadConfigFile, pendingApprovalsPath, saveApprovalState, } from './config-io.js';
import { recordApproval } from './core/approval-service.js';
import { recordCapabilityApproval } from './core/capability-approval.js';
import { recordEgressApproval } from './core/egress-approval.js';
import { createEgressApprovalStore } from './egress-service.js';
import { createCapabilityApprovalStore } from './sandbox-service.js';
export async function approvePending(options) {
    const repoRoot = path.resolve(options.targetDir ?? process.cwd());
    const config = await loadConfigFile(repoRoot);
    const pending = await loadApprovalState(repoRoot, 'pending-approvals.json', config);
    const match = pending.approvals.find((approval) => approval.approvalId === options.approvalId);
    if (match?.kind === 'egress') {
        const result = await recordEgressApproval({
            approvalId: options.approvalId,
            config,
            scope: (options.scope === 'domain' ? 'domain' : 'once'),
            token: options.token,
            requireSignedToken: config.approvalSigning.required,
            store: createEgressApprovalStore(repoRoot, config),
        });
        return { ok: result.ok, message: result.message };
    }
    if (options.scope === 'path') {
        const result = await recordCapabilityApproval({
            approvalId: options.approvalId,
            config,
            scope: 'path',
            scopePath: options.scopePath,
            token: options.token,
            requireSignedToken: config.approvalSigning.required,
            store: createCapabilityApprovalStore(repoRoot, config),
        });
        return { ok: result.ok, message: result.message };
    }
    const result = await recordApproval({
        approvalId: options.approvalId,
        config,
        token: options.token,
        requireSignedToken: config.approvalSigning.required,
        store: {
            async loadPending() {
                const filePath = pendingApprovalsPath(repoRoot, config);
                return {
                    filePath,
                    state: await loadApprovalState(repoRoot, 'pending-approvals.json', config),
                };
            },
            async loadApproved() {
                const filePath = approvedApprovalsPath(repoRoot, config);
                return {
                    filePath,
                    state: await loadApprovalState(repoRoot, 'approved-approvals.json', config),
                };
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
