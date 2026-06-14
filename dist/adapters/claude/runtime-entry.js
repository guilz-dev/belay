import process from 'node:process';
import { unnormalizedGateVerdict } from '../../core/gate-contract.js';
import { claudeLayout } from '../layouts/claude.js';
import { appendObservedAudit, createDefaultGateRuntimeDeps, evaluateGatedAction, gateVerdictToClaudePreToolUseResponse, gateVerdictToClaudeUserPromptResponse, processApprovalPrompt, resolveGateConfig, } from '../shared/gate-runtime.js';
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
    if (toolName === 'Write' ||
        toolName === 'Edit' ||
        toolName === 'Delete' ||
        toolName === 'NotebookEdit' ||
        toolName === 'MultiEdit') {
        return 'tool';
    }
    if (toolName.startsWith('mcp__')) {
        return 'mcp';
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
    if (toolName === 'Task') {
        return payload;
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
    if (toolName === 'NotebookEdit' || toolName === 'MultiEdit') {
        const toolInput = payload.tool_input;
        const input = toolInput && typeof toolInput === 'object' ? toolInput : null;
        const directPath = typeof input?.file_path === 'string'
            ? input.file_path
            : typeof input?.path === 'string'
                ? input.path
                : null;
        if (!directPath) {
            return null;
        }
        return {
            tool_name: toolName === 'NotebookEdit' ? 'Write' : 'StrReplace',
            tool_input: { path: directPath },
        };
    }
    return null;
}
export async function runBeforeSubmitPromptHook() {
    try {
        const payload = await readStdinJson();
        const prompt = String(payload.prompt ?? process.env.CLAUDE_USER_PROMPT ?? '');
        const ctx = await loadRuntimeContext(process.cwd());
        const deps = createDefaultGateRuntimeDeps();
        const result = await processApprovalPrompt(ctx, deps, prompt);
        jsonResponse(gateVerdictToClaudeUserPromptResponse(result));
    }
    catch {
        jsonResponse({
            hookSpecificOutput: {
                hookEventName: 'UserPromptSubmit',
                continue: false,
                user_message: 'belay failed while processing approval state. Run belay doctor, then retry.',
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
                permissionDecisionReason: 'belay failed while classifying this shell command. Run belay doctor, then retry.',
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
        if (mappedKind === 'mcp') {
            await deps.appendAudit(ctx, {
                event: 'preToolUse',
                kind: 'tool',
                verdict: 'deny_pending_approval',
                reason: 'unsupported_mcp_tool',
                mode: ctx.config.mode,
                wouldBlock: true,
                permission: 'deny',
                summary: toolName,
            });
            const verdict = unnormalizedGateVerdict({
                reason: 'unsupported_mcp_tool',
                mode: ctx.config.mode,
                user_message: 'belay blocked this MCP tool because Claude MCP payloads are not normalized safely yet.',
                agent_message: 'Belay denied this MCP tool because its payload shape is unsupported.',
            });
            jsonResponse(gateVerdictToClaudePreToolUseResponse(verdict));
            return;
        }
        if (!mappedKind) {
            await deps.appendAudit(ctx, {
                event: 'preToolUse',
                kind: 'tool',
                verdict: 'deny_pending_approval',
                reason: 'unmapped_tool',
                mode: ctx.config.mode,
                wouldBlock: true,
                permission: 'deny',
                summary: toolName,
            });
            const verdict = unnormalizedGateVerdict({
                reason: 'unmapped_tool',
                mode: ctx.config.mode,
                user_message: 'belay does not recognize this tool action. Run belay doctor, then retry.',
                agent_message: 'Belay denied this action because the tool could not be normalized.',
            });
            jsonResponse(gateVerdictToClaudePreToolUseResponse(verdict));
            return;
        }
        const normalizedPayload = normalizeClaudeToolPayload(toolName, payload);
        if (!normalizedPayload) {
            await deps.appendAudit(ctx, {
                event: 'preToolUse',
                kind: 'tool',
                verdict: 'deny_pending_approval',
                reason: 'normalization_failed',
                mode: ctx.config.mode,
                wouldBlock: true,
                permission: 'deny',
                summary: toolName,
            });
            const verdict = unnormalizedGateVerdict({
                reason: 'normalization_failed',
                mode: ctx.config.mode,
                user_message: 'belay could not normalize this Claude tool payload. Run belay doctor, then retry.',
                agent_message: 'Belay denied this action because the Claude tool payload could not be normalized.',
            });
            jsonResponse(gateVerdictToClaudePreToolUseResponse(verdict));
            return;
        }
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
                permissionDecisionReason: 'belay failed while classifying this tool action. Run belay doctor, then retry.',
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
        console.error('belay audit hook failed:', error instanceof Error ? error.message : String(error));
        jsonResponse({});
    }
}
