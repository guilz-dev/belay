import { classifyShell } from './classify-shell.js';
import { classifySubagent } from './classify-subagent.js';
import { classifyToolUse } from './classify-tool.js';
import { classifierOptionsFromConfig } from './config.js';
import { GATE_CONTRACT_VERSION } from './gate-contract.js';
export class GateNormalizationError extends Error {
    reason = 'normalization_failed';
    constructor(message) {
        super(message);
        this.name = 'GateNormalizationError';
    }
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
export function classifyGatedAction(action, config) {
    const options = classifierOptionsFromConfig(config);
    if (action.kind === 'shell') {
        const command = action.command ?? shellCommandFromPayload(action.payload ?? {});
        if (!command) {
            throw new GateNormalizationError('Shell gated action requires a command.');
        }
        return classifyShell(command, action.cwd, action.repoRoot, options);
    }
    if (action.kind === 'subagent') {
        return classifySubagent(action.payload ?? {}, action.repoRoot, options);
    }
    return classifyToolUse(action.payload ?? {}, action.repoRoot, action.cwd, options);
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
