import { DEFAULT_CONFIG_V3 } from './core/config.js';
export const PACKAGE_NAME = 'agent-belay';
export const DEFAULT_CONFIG = DEFAULT_CONFIG_V3;
function runnerCommand(platform, hookName, ...args) {
    const base = platform === 'win32' ? '.\\.cursor\\hooks\\belay-runner.cmd' : './.cursor/hooks/belay-runner';
    return [base, hookName, ...args].join(' ');
}
export function getManagedHookEntries(platform = process.platform) {
    const toolGate = runnerCommand(platform, 'belay-tool-gate', 'preToolUse');
    const subagentGate = runnerCommand(platform, 'belay-tool-gate', 'subagentStart');
    return [
        {
            event: 'beforeSubmitPrompt',
            definition: {
                command: runnerCommand(platform, 'belay-before-submit'),
                placement: 'prepend',
            },
        },
        {
            event: 'beforeShellExecution',
            definition: {
                command: runnerCommand(platform, 'belay-shell-gate'),
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
                command: runnerCommand(platform, 'belay-audit', 'postToolUse'),
                placement: 'append',
            },
        },
        {
            event: 'stop',
            definition: {
                command: runnerCommand(platform, 'belay-audit', 'stop'),
                placement: 'append',
            },
        },
        {
            event: 'sessionEnd',
            definition: {
                command: runnerCommand(platform, 'belay-audit', 'sessionEnd'),
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
