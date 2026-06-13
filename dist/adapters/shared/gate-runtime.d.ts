import type { GatedActionKind } from '../../core/gate-contract.js';
import { type GatePermissionResponse, type GateVerdict } from '../../core/gate-contract.js';
import { GateNormalizationError } from '../../core/gate-engine.js';
import { type ApprovalStateFile, type BelayConfigV3 } from '../../core/index.js';
import type { ClassifierOptions } from '../../core/types.js';
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
export declare function repoShellClassifierOptions(config: BelayConfigV3, repoRoot: string, layout: AdapterLayout, extras?: ClassifierOptions): ClassifierOptions;
export declare function runtimeClassifierOptions(ctx: GateRuntimeContext, config: BelayConfigV3): ClassifierOptions;
export declare function evaluateGatedAction(ctx: GateRuntimeContext, deps: GateRuntimeDeps, params: {
    kind: GatedActionKind;
    cwd: string;
    command?: string;
    payload?: Record<string, unknown>;
    toolName?: string;
}): Promise<GateVerdict>;
/** R39: unmapped Codex tools ask via pending approval — not hard deny without approval path. */
export declare function gateUnmappedToolVerdict(ctx: GateRuntimeContext, deps: GateRuntimeDeps, toolName: string, payload: Record<string, unknown>): Promise<GateVerdict>;
export declare function processApprovalPrompt(ctx: GateRuntimeContext, deps: GateRuntimeDeps, prompt: string): Promise<{
    continue: boolean;
    user_message?: string;
}>;
export declare function gateVerdictToCursorResponse(verdict: GateVerdict): GatePermissionResponse;
export declare function gateVerdictToClaudePreToolUseResponse(verdict: GateVerdict): Record<string, unknown>;
export declare function gateVerdictToClaudeUserPromptResponse(verdict: {
    continue: boolean;
    user_message?: string;
}): Record<string, unknown>;
export declare function gateVerdictToCodexPreToolUseResponse(verdict: GateVerdict): Record<string, unknown>;
export declare function gateVerdictToCodexUserPromptResponse(verdict: {
    continue: boolean;
    user_message?: string;
}): Record<string, unknown>;
export declare function appendObservedAudit(ctx: GateRuntimeContext, deps: GateRuntimeDeps, eventName: string, payload: Record<string, unknown>): Promise<void>;
export { GateNormalizationError };
