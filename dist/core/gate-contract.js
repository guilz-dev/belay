export const GATE_CONTRACT_VERSION = 1;
export function isGatedAction(value) {
    if (typeof value !== 'object' || value === null) {
        return false;
    }
    const record = value;
    return (record.contractVersion === GATE_CONTRACT_VERSION &&
        (record.kind === 'shell' || record.kind === 'subagent' || record.kind === 'tool') &&
        typeof record.repoRoot === 'string' &&
        typeof record.cwd === 'string');
}
export function classifyResultToGateVerdict(params) {
    const { result, mode, permission, wouldBlock, approvalId, user_message, agent_message } = params;
    return {
        contractVersion: GATE_CONTRACT_VERSION,
        verdict: result.verdict,
        reason: result.reason,
        fingerprint: result.fingerprint,
        assessment: result.assessment,
        normalizedCommand: result.normalizedCommand,
        summary: result.summary,
        permission,
        wouldBlock,
        mode,
        approvalId,
        user_message,
        agent_message,
        v2: result.v2,
    };
}
export function unnormalizedGateVerdict(params) {
    return {
        contractVersion: GATE_CONTRACT_VERSION,
        verdict: 'deny_pending_approval',
        reason: params.reason,
        fingerprint: 'unnormalized',
        assessment: {
            reversibility: 'irreversible',
            external: true,
            blastRadius: 'unknown',
            confidence: 0,
            signals: ['normalization_failed'],
        },
        permission: 'deny',
        wouldBlock: true,
        mode: params.mode,
        user_message: params.user_message,
        agent_message: params.agent_message,
    };
}
