import type { Assessment, ClassifyResult, HookVerdict } from './types.js';
export declare const GATE_CONTRACT_VERSION: 1;
export type GatedActionKind = 'shell' | 'subagent' | 'tool';
export interface GatedAction {
    contractVersion: typeof GATE_CONTRACT_VERSION;
    kind: GatedActionKind;
    repoRoot: string;
    cwd: string;
    command?: string;
    payload?: Record<string, unknown>;
    toolName?: string;
    /** Reserved for v0.5 agent-side assessment ingestion. */
    agentAssessment?: Assessment;
}
export interface GatePermissionResponse {
    permission: 'allow' | 'deny';
    user_message?: string;
    agent_message?: string;
}
export interface GateVerdict extends GatePermissionResponse {
    contractVersion: typeof GATE_CONTRACT_VERSION;
    verdict: HookVerdict;
    reason: string;
    fingerprint: string;
    assessment: Assessment;
    normalizedCommand?: string;
    summary?: string;
    approvalId?: string;
    wouldBlock: boolean;
    mode: 'enforce' | 'audit';
    v2?: ClassifyResult['v2'];
}
export declare function isGatedAction(value: unknown): value is GatedAction;
export declare function classifyResultToGateVerdict(params: {
    result: ClassifyResult;
    mode: 'enforce' | 'audit';
    permission: 'allow' | 'deny';
    wouldBlock: boolean;
    approvalId?: string;
    user_message?: string;
    agent_message?: string;
}): GateVerdict;
export declare function unnormalizedGateVerdict(params: {
    reason: string;
    mode: 'enforce' | 'audit';
    user_message: string;
    agent_message?: string;
}): GateVerdict;
