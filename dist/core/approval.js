export function nowIso() {
    return new Date().toISOString();
}
export function isExpired(approval) {
    return Date.parse(approval.expiresAt) <= Date.now();
}
export function compactApprovals(state) {
    return {
        version: state.version,
        approvals: state.approvals.filter((approval) => !isExpired(approval)),
    };
}
export function mergeApprovalStates(target, source) {
    const byId = new Map();
    for (const approval of target.approvals) {
        byId.set(approval.approvalId, approval);
    }
    for (const approval of source.approvals) {
        if (!byId.has(approval.approvalId)) {
            byId.set(approval.approvalId, approval);
        }
    }
    return compactApprovals({
        version: target.version === 2 || source.version === 2 ? 2 : 1,
        approvals: [...byId.values()],
    });
}
export function escapeRegex(value) {
    const specials = new Set(['.', '*', '+', '?', '^', '$', '{', '}', '(', ')', '|', '[', ']', '\\']);
    return [...value].map((char) => (specials.has(char) ? `\\${char}` : char)).join('');
}
export function approvalCommandMatch(prompt, tokenPrefix) {
    const escapedPrefix = escapeRegex(tokenPrefix);
    const match = prompt.match(new RegExp(`^\\s*${escapedPrefix}\\s+(\\S+)\\s*$`, 'i'));
    return match?.[1] ?? null;
}
export function buildRetryInstruction(tokenPrefix, approvalId) {
    return `To allow the next matching action once, send ${tokenPrefix} ${approvalId} and then retry the original action unchanged.`;
}
export function createApprovalRecord(params) {
    const createdAt = nowIso();
    const expiresAt = new Date(Date.now() + params.approvalTtlMinutes * 60_000).toISOString();
    const record = {
        approvalId: params.approvalId,
        kind: params.kind,
        fingerprint: params.fingerprint,
        repoRoot: params.repoRoot,
        reason: params.reason,
        summary: params.summary,
        createdAt,
        expiresAt,
    };
    if (params.input) {
        record.input = params.input;
        record.inputKind = params.inputKind ?? params.kind;
    }
    return record;
}
