import process from 'node:process';
import { cursorLayout } from '../layouts/cursor.js';
import { appendObservedAudit, createDefaultGateRuntimeDeps, evaluateGatedAction, gateVerdictToCursorResponse, processApprovalPrompt, resolveGateConfig, } from '../shared/gate-runtime.js';
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
    const repoRoot = findRepoRoot(cwd, cursorLayout);
    const configPath = cursorLayout.configPath(repoRoot);
    const deps = createDefaultGateRuntimeDeps();
    const config = await resolveGateConfig({ layout: cursorLayout, repoRoot, configPath }, deps);
    return { layout: cursorLayout, repoRoot, config, configPath };
}
function isSubagentEvent(payload, eventName) {
    return eventName === 'subagentStart' || payload.subagent_type !== undefined;
}
function isFileMutationTool(toolName) {
    return toolName === 'Write' || toolName === 'StrReplace' || toolName === 'Delete';
}
export async function runBeforeSubmitPromptHook() {
    try {
        const payload = await readStdinJson();
        const prompt = String(payload.prompt ?? '');
        const ctx = await loadRuntimeContext(process.cwd());
        const deps = createDefaultGateRuntimeDeps();
        const result = await processApprovalPrompt(ctx, deps, prompt);
        jsonResponse({
            continue: result.continue,
            ...(result.user_message ? { user_message: result.user_message } : {}),
        });
    }
    catch {
        jsonResponse({
            continue: false,
            user_message: 'agent-belay failed while processing approval state. Run agent-belay doctor, then retry.',
        });
    }
}
export async function runShellGateHook() {
    try {
        const payload = await readStdinJson();
        const command = String(payload.command ?? '').trim();
        const cwd = String(payload.cwd ?? process.cwd()).trim() || process.cwd();
        const ctx = await loadRuntimeContext(cwd);
        const deps = createDefaultGateRuntimeDeps();
        const verdict = await evaluateGatedAction(ctx, deps, {
            kind: 'shell',
            cwd,
            command,
        });
        jsonResponse(gateVerdictToCursorResponse(verdict));
    }
    catch {
        jsonResponse({
            permission: 'deny',
            user_message: 'agent-belay failed while classifying this shell command. Run agent-belay doctor, then retry.',
        });
    }
}
export async function runToolGateHook(eventName) {
    try {
        const payload = await readStdinJson();
        const cwd = process.cwd();
        const ctx = await loadRuntimeContext(cwd);
        const deps = createDefaultGateRuntimeDeps();
        const toolName = String(payload.tool_name ?? '');
        if (isSubagentEvent(payload, eventName)) {
            const verdict = await evaluateGatedAction(ctx, deps, {
                kind: 'subagent',
                cwd,
                payload,
            });
            jsonResponse(gateVerdictToCursorResponse(verdict));
            return;
        }
        if (toolName === 'Shell') {
            const verdict = await evaluateGatedAction(ctx, deps, {
                kind: 'shell',
                cwd,
                payload,
                toolName,
            });
            jsonResponse(gateVerdictToCursorResponse(verdict));
            return;
        }
        if (isFileMutationTool(toolName)) {
            const verdict = await evaluateGatedAction(ctx, deps, {
                kind: 'tool',
                cwd,
                payload,
                toolName,
            });
            jsonResponse(gateVerdictToCursorResponse(verdict));
            return;
        }
        if (payload.tool_name === 'Task') {
            const verdict = await evaluateGatedAction(ctx, deps, {
                kind: 'subagent',
                cwd,
                payload,
            });
            jsonResponse(gateVerdictToCursorResponse(verdict));
            return;
        }
        jsonResponse({ permission: 'allow' });
    }
    catch {
        jsonResponse({
            permission: 'deny',
            user_message: 'agent-belay failed while classifying this tool action. Run agent-belay doctor, then retry.',
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
