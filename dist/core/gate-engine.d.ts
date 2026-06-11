import type { BelayConfigV3 } from './config.js';
import type { GatedAction, GatedActionKind } from './gate-contract.js';
import type { Assessment, ClassifierOptions, ClassifyResult } from './types.js';
export declare class GateNormalizationError extends Error {
    readonly reason = "normalization_failed";
    constructor(message: string);
}
export declare function extractAgentAssessment(payload?: Record<string, unknown>): Assessment | undefined;
export declare function normalizeGatedAction(params: {
    kind: GatedActionKind;
    repoRoot: string;
    cwd: string;
    command?: string;
    payload?: Record<string, unknown>;
    toolName?: string;
    agentAssessment?: GatedAction['agentAssessment'];
}): GatedAction;
export declare function classifyGatedAction(action: GatedAction, config: BelayConfigV3, extraOptions?: ClassifierOptions): ClassifyResult;
export declare function classifyGatedActionAsync(action: GatedAction, config: BelayConfigV3, extraOptions?: ClassifierOptions): Promise<ClassifyResult>;
export declare function gateEnabledForAction(config: BelayConfigV3, action: GatedAction): boolean;
