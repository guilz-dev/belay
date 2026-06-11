import process from 'node:process';
import { unnormalizedGateVerdict } from '../../core/gate-contract.js';
import { claudeLayout } from '../layouts/claude.js';
import { appendObservedAudit, createDefaultGateRuntimeDeps, evaluateGatedAction, gateVerdictToClaudePreToolUseResponse, gateVerdictToClaudeUserPromptResponse, maybeRunControlPlaneSpike, processApprovalPrompt, resolveGateConfig, } from '../shared/gate-runtime.js';
import { findRepoRoot } from '../shared/repo-root.js';
async function readStdinJson() {
    const chunks = [];
    for await (const chunk of process.stdin) {
        chunks.push(typeof chunk === 'string' ? chunk : chunk.toString('utf8'));
    }
    const raw = chunks.join('').trim();
    if (!raw) {
        return {};
    }
    try {
        return JSON.parse(raw);
    }
    catch {
        return {};
    }
}
function jsonResponse(value) {
    process.stdout.write(`${JSON.stringify(value)}\n`);
}
async function loadRuntimeContext(cwd) {
    const repoRoot = findRepoRoot(cwd, claudeLayout);
    const configPath = claudeLayout.configPath(repoRoot);
    const deps = createDefaultGateRuntimeDeps();
    const config = await resolveGateConfig({ layout: claudeLayout, repoRoot, configPath }, deps);
    return { layout: claudeLayout, repoRoot, config, configPath };
}
function mapClaudeToolName(toolName) {
    if (toolName === 'Bash') {
        return 'shell';
    }
    if (toolName === 'Task') {
        return 'subagent';
    }
    if (toolName === 'Write' || toolName === 'Edit' || toolName === 'Delete') {
        return 'tool';
    }
    return null;
}
function normalizeClaudeToolPayload(toolName, payload) {
    if (toolName === 'Bash') {
        const toolInput = payload.tool_input;
        const command = toolInput && typeof toolInput === 'object'
            ? String(toolInput.command ?? '')
            : '';
        return {
            tool_name: 'Shell',
            tool_input: { command },
        };
    }
    if (toolName === 'Edit') {
        const toolInput = payload.tool_input;
        const filePath = toolInput && typeof toolInput === 'object'
            ? String(toolInput.file_path ?? '')
            : '';
        return {
            tool_name: 'StrReplace',
            tool_input: { path: filePath },
        };
    }
    if (toolName === 'Write') {
        const toolInput = payload.tool_input;
        const filePath = toolInput && typeof toolInput === 'object'
            ? String(toolInput.file_path ?? '')
            : '';
        return {
            tool_name: 'Write',
            tool_input: { path: filePath },
        };
    }
    if (toolName === 'Delete') {
        const toolInput = payload.tool_input;
        const filePath = toolInput && typeof toolInput === 'object'
            ? String(toolInput.path ?? '')
            : '';
        return {
            tool_name: 'Delete',
            tool_input: { path: filePath },
        };
    }
    return payload;
}
export async function runBeforeSubmitPromptHook() {
    try {
        const payload = await readStdinJson();
        const prompt = String(payload.prompt ?? process.env.CLAUDE_USER_PROMPT ?? '');
        const ctx = await loadRuntimeContext(process.cwd());
        const deps = createDefaultGateRuntimeDeps();
        await maybeRunControlPlaneSpike(ctx, deps, process.env.BELAY_OQ3_SPIKE === '1');
        const result = await processApprovalPrompt(ctx, deps, prompt);
        jsonResponse(gateVerdictToClaudeUserPromptResponse(result));
    }
    catch {
        jsonResponse({
            hookSpecificOutput: {
                hookEventName: 'UserPromptSubmit',
                continue: false,
                user_message: 'agent-belay failed while processing approval state. Run agent-belay doctor, then retry.',
            },
        });
    }
}
export async function runShellGateHook() {
    try {
        const payload = await readStdinJson();
        const toolInput = payload.tool_input;
        const command = toolInput && typeof toolInput === 'object'
            ? String(toolInput.command ?? '')
            : String(payload.command ?? '');
        const cwd = process.cwd();
        const ctx = await loadRuntimeContext(cwd);
        const deps = createDefaultGateRuntimeDeps();
        const verdict = await evaluateGatedAction(ctx, deps, {
            kind: 'shell',
            cwd,
            command,
            payload,
            toolName: 'Bash',
        });
        jsonResponse(gateVerdictToClaudePreToolUseResponse(verdict));
    }
    catch {
        jsonResponse({
            hookSpecificOutput: {
                hookEventName: 'PreToolUse',
                permissionDecision: 'deny',
                permissionDecisionReason: 'agent-belay failed while classifying this shell command. Run agent-belay doctor, then retry.',
            },
        });
    }
}
export async function runToolGateHook(_eventName) {
    try {
        const payload = await readStdinJson();
        const cwd = process.cwd();
        const ctx = await loadRuntimeContext(cwd);
        const deps = createDefaultGateRuntimeDeps();
        const toolName = String(payload.tool_name ?? '');
        const mappedKind = mapClaudeToolName(toolName);
        if (!mappedKind) {
            const verdict = unnormalizedGateVerdict({
                reason: 'unmapped_tool',
                mode: ctx.config.mode,
                user_message: 'agent-belay does not recognize this tool action. Run agent-belay doctor, then retry.',
                agent_message: 'Belay denied this action because the tool could not be normalized.',
            });
            jsonResponse(gateVerdictToClaudePreToolUseResponse(verdict));
            return;
        }
        const normalizedPayload = normalizeClaudeToolPayload(toolName, payload);
        const verdict = await evaluateGatedAction(ctx, deps, {
            kind: mappedKind,
            cwd,
            payload: normalizedPayload,
            toolName,
        });
        jsonResponse(gateVerdictToClaudePreToolUseResponse(verdict));
    }
    catch {
        jsonResponse({
            hookSpecificOutput: {
                hookEventName: 'PreToolUse',
                permissionDecision: 'deny',
                permissionDecisionReason: 'agent-belay failed while classifying this tool action. Run agent-belay doctor, then retry.',
            },
        });
    }
}
export async function runAuditHook(eventName) {
    try {
        const payload = await readStdinJson();
        const ctx = await loadRuntimeContext(process.cwd());
        const deps = createDefaultGateRuntimeDeps();
        await appendObservedAudit(ctx, deps, eventName, payload);
        jsonResponse({});
    }
    catch (error) {
        console.error('agent-belay audit hook failed:', error instanceof Error ? error.message : String(error));
        jsonResponse({});
    }
}
