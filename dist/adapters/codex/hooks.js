import path from 'node:path';
import { buildRunnerInvocation } from '../layouts/scope.js';
export const CODEX_HOOKS_BEGIN = '# --- BELAY MANAGED HOOKS BEGIN (managed by belay; do not edit) ---';
export const CODEX_HOOKS_END = '# --- BELAY MANAGED HOOKS END ---';
const HOOK_TIMEOUT_SECONDS = 30;
const CODEX_HOOK_SPECS = [
    { event: 'PreToolUse', matcher: '.*', runnerArgs: ['belay-tool-gate', 'PreToolUse'] },
    { event: 'SubagentStart', runnerArgs: ['belay-tool-gate', 'SubagentStart'] },
    { event: 'UserPromptSubmit', runnerArgs: ['belay-before-submit'] },
    { event: 'PostToolUse', runnerArgs: ['belay-audit', 'PostToolUse'] },
];
function tomlString(value) {
    return `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
}
function runnerCommand(platform, hooksDir, repoRoot, hookName, ...args) {
    return buildRunnerInvocation(platform, hooksDir, repoRoot, hookName, ...args);
}
/**
 * Render belay's Codex lifecycle hooks as a marker-delimited TOML block for `.codex/config.toml`.
 * The block is replaced wholesale on re-init/upgrade (see mergeCodexHooksToml), so we avoid a
 * full TOML parser while staying idempotent.
 */
export function renderCodexHooksToml(platform, hooksDir, repoRoot) {
    const lines = [CODEX_HOOKS_BEGIN];
    for (const spec of CODEX_HOOK_SPECS) {
        const command = runnerCommand(platform, hooksDir, repoRoot, spec.runnerArgs[0], ...spec.runnerArgs.slice(1));
        lines.push('');
        lines.push(`[[hooks.${spec.event}]]`);
        if (spec.matcher !== undefined) {
            lines.push(`matcher = ${tomlString(spec.matcher)}`);
        }
        lines.push(`[[hooks.${spec.event}.hooks]]`);
        lines.push('type = "command"');
        lines.push(`command = ${tomlString(command)}`);
        lines.push(`timeout = ${HOOK_TIMEOUT_SECONDS}`);
    }
    lines.push('');
    lines.push(CODEX_HOOKS_END);
    return `${lines.join('\n')}\n`;
}
/**
 * Merge belay's managed hooks block into an existing `.codex/config.toml` body idempotently:
 * strip any prior BELAY MANAGED HOOKS block, then append the freshly rendered one.
 */
export function mergeCodexHooksToml(existing, platform, hooksDir, repoRoot) {
    const block = renderCodexHooksToml(platform, hooksDir, repoRoot);
    const stripped = stripManagedBlock(existing);
    const base = stripped.replace(/\s*$/, '');
    if (base.length === 0) {
        return block;
    }
    return `${base}\n\n${block}`;
}
function stripManagedBlock(content) {
    const begin = content.indexOf(CODEX_HOOKS_BEGIN);
    if (begin === -1) {
        return content;
    }
    const endMarker = content.indexOf(CODEX_HOOKS_END, begin);
    if (endMarker === -1) {
        // Malformed (begin without end): drop from begin to EOF to avoid leaving a broken block.
        return content.slice(0, begin);
    }
    return content.slice(0, begin) + content.slice(endMarker + CODEX_HOOKS_END.length);
}
// Used by adapter.hookEvents() for diagnostics/parity with other adapters.
export function getCodexManagedHookEntries(platform = process.platform, hooksDir, repoRoot) {
    const resolvedRepo = path.resolve(repoRoot ?? process.cwd());
    const resolvedHooksDir = hooksDir ?? path.join(resolvedRepo, '.codex', 'hooks');
    return CODEX_HOOK_SPECS.map((spec) => ({
        event: spec.event,
        definition: {
            command: runnerCommand(platform, resolvedHooksDir, resolvedRepo, spec.runnerArgs[0], ...spec.runnerArgs.slice(1)),
            placement: 'prepend',
            matcher: spec.matcher,
        },
    }));
}
