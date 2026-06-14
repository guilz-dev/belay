import path from 'node:path';
import { cursorLayout } from './adapters/layouts/cursor.js';
import { buildRunnerInvocation } from './adapters/layouts/scope.js';
import { DEFAULT_CONFIG_V3 } from './core/config.js';
export { PACKAGE_NAME } from './branding.js';
export const DEFAULT_CONFIG = DEFAULT_CONFIG_V3;
function runnerCommand(platform, hooksDir, repoRoot, hookScript, ...args) {
    return buildRunnerInvocation(platform, hooksDir, repoRoot, hookScript, ...args);
}
export function getManagedHookEntries(platform = process.platform, hooksDir, repoRoot) {
    const resolvedRepo = path.resolve(repoRoot ?? process.cwd());
    const resolvedHooksDir = hooksDir ?? cursorLayout.hooksDir(resolvedRepo);
    const toolGate = runnerCommand(platform, resolvedHooksDir, resolvedRepo, 'belay-tool-gate', 'preToolUse');
    const subagentGate = runnerCommand(platform, resolvedHooksDir, resolvedRepo, 'belay-tool-gate', 'subagentStart');
    return [
        {
            event: 'beforeSubmitPrompt',
            definition: {
                command: runnerCommand(platform, resolvedHooksDir, resolvedRepo, 'belay-before-submit'),
                placement: 'prepend',
            },
        },
        {
            event: 'beforeShellExecution',
            definition: {
                command: runnerCommand(platform, resolvedHooksDir, resolvedRepo, 'belay-shell-gate'),
                placement: 'prepend',
            },
        },
        {
            event: 'preToolUse',
            definition: {
                command: toolGate,
                placement: 'prepend',
                matcher: 'Task',
            },
        },
        {
            event: 'preToolUse',
            definition: {
                command: toolGate,
                placement: 'prepend',
                matcher: 'Shell',
            },
        },
        {
            event: 'preToolUse',
            definition: {
                command: toolGate,
                placement: 'prepend',
                matcher: 'Write',
            },
        },
        {
            event: 'preToolUse',
            definition: {
                command: toolGate,
                placement: 'prepend',
                matcher: 'StrReplace',
            },
        },
        {
            event: 'preToolUse',
            definition: {
                command: toolGate,
                placement: 'prepend',
                matcher: 'Delete',
            },
        },
        {
            event: 'subagentStart',
            definition: {
                command: subagentGate,
                placement: 'prepend',
                matcher: 'generalPurpose',
            },
        },
        {
            event: 'subagentStart',
            definition: {
                command: subagentGate,
                placement: 'prepend',
                matcher: 'computerUse',
            },
        },
        {
            event: 'subagentStart',
            definition: {
                command: subagentGate,
                placement: 'prepend',
                matcher: 'debug',
            },
        },
        {
            event: 'subagentStart',
            definition: {
                command: subagentGate,
                placement: 'prepend',
                matcher: 'explore',
            },
        },
        {
            event: 'subagentStart',
            definition: {
                command: subagentGate,
                placement: 'prepend',
                matcher: 'videoReview',
            },
        },
        {
            event: 'subagentStart',
            definition: {
                command: subagentGate,
                placement: 'prepend',
                matcher: 'bugbot',
            },
        },
        {
            event: 'postToolUse',
            definition: {
                command: runnerCommand(platform, resolvedHooksDir, resolvedRepo, 'belay-audit', 'postToolUse'),
                placement: 'append',
            },
        },
        {
            event: 'stop',
            definition: {
                command: runnerCommand(platform, resolvedHooksDir, resolvedRepo, 'belay-audit', 'stop'),
                placement: 'append',
            },
        },
        {
            event: 'sessionEnd',
            definition: {
                command: runnerCommand(platform, resolvedHooksDir, resolvedRepo, 'belay-audit', 'sessionEnd'),
                placement: 'append',
            },
        },
    ];
}
/** @deprecated Use getManagedHookEntries instead. */
export function getManagedHookEvents(platform = process.platform) {
    const entries = getManagedHookEntries(platform);
    const result = {};
    for (const entry of entries) {
        if (!result[entry.event]) {
            result[entry.event] = entry.definition;
        }
    }
    return result;
}
export const EMPTY_APPROVALS = {
    version: 1,
    approvals: [],
};
