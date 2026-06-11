import type { GatedActionKind } from '../../core/gate-contract.js';
import { type GatePermissionResponse, type GateVerdict } from '../../core/gate-contract.js';
import { GateNormalizationError } from '../../core/gate-engine.js';
import { type ApprovalStateFile, type BelayConfigV3 } from '../../core/index.js';
import type { AdapterLayout } from '../layouts/types.js';
export interface GateRuntimeContext {
    layout: AdapterLayout;
    repoRoot: string;
    config: BelayConfigV3;
    configPath: string;
}
export interface GateRuntimeDeps {
    readConfig: (configPath: string) => Promise<unknown>;
    appendAudit: (ctx: GateRuntimeContext, event: Record<string, unknown>) => Promise<void>;
    loadApprovals: (ctx: GateRuntimeContext, fileName: 'pending-approvals.json' | 'approved-approvals.json') => Promise<{
        filePath: string;
        state: ApprovalStateFile;
    }>;
    writeApprovals: (filePath: string, state: ApprovalStateFile) => Promise<void>;
}
export declare function createDefaultGateRuntimeDeps(): GateRuntimeDeps;
export declare function resolveGateConfig(ctx: Pick<GateRuntimeContext, 'layout' | 'repoRoot' | 'configPath'>, deps: GateRuntimeDeps): Promise<BelayConfigV3>;
export declare function runtimeClassifierOptions(ctx: GateRuntimeContext, config: BelayConfigV3): {
    protectedArtifactRoots: string[];
    strictChains?: boolean;
    customExternalCommands?: string[];
    customAllowCommands?: string[];
    sensitivePaths?: string[];
    unknownLocalEffect?: import("../../types.js").UnknownLocalEffectPolicy;
    unparseableShell?: import("../../core/types.js").UnparseableShellPolicy;
    controlPlaneDir?: string | null;
    scrubOptions?: import("../../core/types.js").ScrubOptions;
};
export declare function evaluateGatedAction(ctx: GateRuntimeContext, deps: GateRuntimeDeps, params: {
    kind: GatedActionKind;
    cwd: string;
    command?: string;
    payload?: Record<string, unknown>;
    toolName?: string;
}): Promise<GateVerdict>;
export declare function processApprovalPrompt(ctx: GateRuntimeContext, deps: GateRuntimeDeps, prompt: string): Promise<{
    continue: boolean;
    user_message?: string;
}>;
export declare function maybeRunControlPlaneSpike(ctx: GateRuntimeContext, deps: GateRuntimeDeps, envEnabled: boolean): Promise<void>;
export declare function gateVerdictToCursorResponse(verdict: GateVerdict): GatePermissionResponse;
export declare function gateVerdictToClaudePreToolUseResponse(verdict: GateVerdict): Record<string, unknown>;
export declare function gateVerdictToClaudeUserPromptResponse(verdict: {
    continue: boolean;
    user_message?: string;
}): Record<string, unknown>;
export declare function appendObservedAudit(ctx: GateRuntimeContext, deps: GateRuntimeDeps, eventName: string, payload: Record<string, unknown>): Promise<void>;
export { GateNormalizationError };
