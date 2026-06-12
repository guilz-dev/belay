import { allPathsAllowlisted } from './capability/allowlist.js';
import { collectOutsideRepoPaths } from './capability/paths.js';
import { classifySubagent } from './classify-subagent.js';
import { classifyToolUse } from './classify-tool.js';
import { classifierOptionsFromConfig } from './config.js';
import { GATE_CONTRACT_VERSION } from './gate-contract.js';
import { mergeAgentAssessment } from './judgment.js';
import { classifyShellV2 } from './v2/adapter.js';
export class GateNormalizationError extends Error {
    reason = 'normalization_failed';
    constructor(message) {
        super(message);
        this.name = 'GateNormalizationError';
    }
}
function parseAssessment(value) {
    if (!value || typeof value !== 'object') {
        return undefined;
    }
    const record = value;
    if ((record.reversibility === 'reversible' ||
        record.reversibility === 'recoverable_with_cost' ||
        record.reversibility === 'irreversible') &&
        typeof record.external === 'boolean' &&
        typeof record.blastRadius === 'string' &&
        typeof record.confidence === 'number' &&
        Array.isArray(record.signals) &&
        record.signals.every((signal) => typeof signal === 'string')) {
        return {
            reversibility: record.reversibility,
            external: record.external,
            blastRadius: record.blastRadius,
            confidence: record.confidence,
            signals: record.signals,
        };
    }
    return undefined;
}
export function extractAgentAssessment(payload) {
    if (!payload) {
        return undefined;
    }
    for (const key of ['agentAssessment', 'assessment']) {
        const parsed = parseAssessment(payload[key]);
        if (parsed) {
            return parsed;
        }
    }
    const toolInput = payload.tool_input;
    if (toolInput && typeof toolInput === 'object') {
        return extractAgentAssessment(toolInput);
    }
    return undefined;
}
function shellCommandFromPayload(payload) {
    const direct = payload.command;
    if (typeof direct === 'string' && direct.trim()) {
        return direct.trim();
    }
    const toolInput = payload.tool_input;
    if (toolInput && typeof toolInput === 'object') {
        const command = toolInput.command;
        if (typeof command === 'string' && command.trim()) {
            return command.trim();
        }
    }
    return '';
}
export function normalizeGatedAction(params) {
    const { kind, repoRoot, cwd, payload, toolName, agentAssessment } = params;
    let command = params.command?.trim() ?? '';
    if (kind === 'shell' && !command && payload) {
        command = shellCommandFromPayload(payload);
    }
    if (kind === 'shell' && !command) {
        throw new GateNormalizationError('Shell gated action requires a command.');
    }
    if (kind === 'tool' && !payload) {
        throw new GateNormalizationError('Tool gated action requires a payload.');
    }
    if (kind === 'subagent' && !payload) {
        throw new GateNormalizationError('Subagent gated action requires a payload.');
    }
    return {
        contractVersion: GATE_CONTRACT_VERSION,
        kind,
        repoRoot,
        cwd,
        command: command || undefined,
        payload,
        toolName,
        agentAssessment,
    };
}
function applyShellPeripheralPolicy(command, action, result, options) {
    if (options.demoteL3External &&
        result.verdict === 'deny_pending_approval' &&
        (result.reason === 'external_effect' || result.assessment.external)) {
        return {
            ...result,
            verdict: 'allow_flagged',
            reason: 'l3_external_hint',
            assessment: {
                ...result.assessment,
                signals: [...result.assessment.signals, 'l3_external_hint', 'egress_boundary_expected'],
            },
        };
    }
    if (options.brokerFsScope &&
        result.verdict === 'deny_pending_approval' &&
        (result.reason === 'outside_repo_mutation' ||
            result.reason === 'outside_repo_redirect' ||
            result.reason === 'repo_outside_mutation' ||
            result.v2?.location === 'repo_outside')) {
        const outsideRepoPaths = collectOutsideRepoPaths(command, action.cwd, action.repoRoot);
        if (outsideRepoPaths.length > 0 &&
            options.fsScopeAllowlist &&
            allPathsAllowlisted(outsideRepoPaths, options.fsScopeAllowlist)) {
            return {
                ...result,
                verdict: 'allow_flagged',
                reason: 'capability_fs_hint',
                assessment: {
                    ...result.assessment,
                    signals: [
                        ...result.assessment.signals,
                        'capability_fs_hint',
                        'sandbox_boundary_expected',
                    ],
                },
            };
        }
    }
    return result;
}
export async function classifyGatedAction(action, config, extraOptions = {}) {
    const options = { ...classifierOptionsFromConfig(config), ...extraOptions };
    if (action.kind === 'shell') {
        const command = action.command ?? shellCommandFromPayload(action.payload ?? {});
        if (!command) {
            throw new GateNormalizationError('Shell gated action requires a command.');
        }
        let result = await classifyShellV2(command, action.cwd, action.repoRoot, config, options);
        result = applyShellPeripheralPolicy(command, action, result, options);
        if (!action.agentAssessment) {
            return result;
        }
        const merged = mergeAgentAssessment(result.assessment, action.agentAssessment);
        if (!merged.mismatch) {
            return { ...result, assessment: merged.assessment };
        }
        return {
            ...result,
            verdict: 'deny_pending_approval',
            reason: 'agent_assessment_mismatch',
            assessment: merged.assessment,
        };
    }
    if (action.kind === 'subagent') {
        return classifySubagent(action.payload ?? {}, action.repoRoot, options);
    }
    return classifyToolUse(action.payload ?? {}, action.repoRoot, action.cwd, options);
}
export async function classifyGatedActionAsync(action, config, extraOptions = {}) {
    return classifyGatedAction(action, config, extraOptions);
}
export function gateEnabledForAction(config, action) {
    if (action.kind === 'shell') {
        return config.gates.shell;
    }
    if (action.kind === 'subagent') {
        return config.gates.subagent;
    }
    const toolName = action.toolName ?? String(action.payload?.tool_name ?? '');
    if (toolName === 'Shell') {
        return config.gates.toolShell;
    }
    if (toolName === 'Write' || toolName === 'StrReplace' || toolName === 'Delete') {
        return config.gates.fileMutation;
    }
    if (toolName === 'Task') {
        return config.gates.subagent;
    }
    return true;
}
