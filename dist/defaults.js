export const PACKAGE_NAME = 'agent-belay';
function runnerCommand(platform, hookName, ...args) {
    const base = platform === 'win32' ? '.\\.cursor\\hooks\\belay-runner.cmd' : './.cursor/hooks/belay-runner';
    return [base, hookName, ...args].join(' ');
}
export function getManagedHookEvents(platform = process.platform) {
    return {
        beforeSubmitPrompt: {
            command: runnerCommand(platform, 'belay-before-submit'),
            placement: 'prepend',
        },
        beforeShellExecution: {
            command: runnerCommand(platform, 'belay-shell-gate'),
            placement: 'prepend',
        },
        preToolUse: {
            command: runnerCommand(platform, 'belay-tool-gate', 'preToolUse'),
            placement: 'prepend',
            matcher: 'Task',
        },
        subagentStart: {
            command: runnerCommand(platform, 'belay-tool-gate', 'subagentStart'),
            placement: 'prepend',
            matcher: 'generalPurpose',
        },
        postToolUse: {
            command: runnerCommand(platform, 'belay-audit', 'postToolUse'),
            placement: 'append',
        },
        stop: {
            command: runnerCommand(platform, 'belay-audit', 'stop'),
            placement: 'append',
        },
        sessionEnd: {
            command: runnerCommand(platform, 'belay-audit', 'sessionEnd'),
            placement: 'append',
        },
    };
}
export const DEFAULT_CONFIG = {
    version: 1,
    mode: 'enforce',
    approvalTtlMinutes: 15,
    tokenPrefix: '/belay-approve',
    gates: {
        shell: true,
        subagent: true,
    },
    audit: {
        logPath: '.cursor/belay/audit.ndjson',
    },
};
export const EMPTY_APPROVALS = {
    version: 1,
    approvals: [],
};
