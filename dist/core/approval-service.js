import { compactApprovals } from './approval.js';
import { verifyApprovalToken } from './approval-token.js';
import { configuredControlPlaneDir } from './config.js';
export async function recordApproval(params) {
    const { approvalId, config, store, token, requireSignedToken = false } = params;
    const pending = await store.loadPending();
    pending.state = compactApprovals(pending.state);
    const index = pending.state.approvals.findIndex((approval) => approval.approvalId === approvalId);
    if (index === -1) {
        await store.writePending(pending.filePath, pending.state);
        return { ok: false, message: 'Belay approval not found or expired.' };
    }
    const [approval] = pending.state.approvals.slice(index, index + 1);
    if (requireSignedToken) {
        if (!token) {
            return { ok: false, message: 'Signed approval token required for out-of-band approval.' };
        }
        const controlPlaneDir = configuredControlPlaneDir(config);
        const verified = await verifyApprovalToken(token, controlPlaneDir);
        if (!verified || verified.approvalId !== approvalId) {
            return { ok: false, message: 'Invalid or expired signed approval token.' };
        }
        if (verified.fingerprint !== approval.fingerprint || verified.repoRoot !== approval.repoRoot) {
            return { ok: false, message: 'Signed approval token does not match the pending approval.' };
        }
    }
    pending.state.approvals.splice(index, 1);
    await store.writePending(pending.filePath, pending.state);
    const approved = await store.loadApproved();
    approved.state = compactApprovals(approved.state);
    approved.state.approvals.push({
        ...approval,
        approvedAt: new Date().toISOString(),
    });
    await store.writeApproved(approved.filePath, approved.state);
    return {
        ok: true,
        message: `Belay approval recorded for ${approvalId}. Retry the original action once before it expires.`,
        approval,
    };
}
