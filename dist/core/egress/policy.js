import { isHostAllowlisted } from './allowlist.js';
import { egressFingerprint, egressSummary } from './fingerprint.js';
const SAFE_READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
export function evaluateEgressConnect(params) {
    const { request, allowlist, approved } = params;
    const host = request.host.toLowerCase();
    const fingerprint = egressFingerprint(request.repoRoot, host, request.port, request.method, request.hasPayload === true);
    const summary = egressSummary(host, request.port, request.method, request.hasPayload === true);
    if (SAFE_READ_METHODS.has(request.method) && request.hasPayload !== true) {
        return {
            decision: 'allow',
            fingerprint,
            summary,
            reason: 'egress_read',
        };
    }
    if (isHostAllowlisted(host, allowlist)) {
        return {
            decision: 'allow',
            fingerprint,
            summary,
            reason: 'egress_allowlist',
        };
    }
    const approvedMatch = approved.approvals.find((approval) => approval.kind === 'egress' &&
        approval.fingerprint === fingerprint &&
        approval.repoRoot === request.repoRoot);
    if (approvedMatch) {
        return {
            decision: 'allow',
            fingerprint,
            summary,
            reason: 'approved_once',
        };
    }
    return {
        decision: 'deny_pending',
        fingerprint,
        summary,
        reason: request.method === 'CONNECT'
            ? 'egress_connect_requires_approval'
            : SAFE_READ_METHODS.has(request.method) && request.hasPayload === true
                ? 'egress_read_with_payload_requires_approval'
                : 'egress_requires_approval',
        approvalId: params.pendingApprovalId,
    };
}
