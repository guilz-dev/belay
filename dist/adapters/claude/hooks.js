function runnerCommand(platform, hookName, ...args) {
    const base = platform === 'win32' ? '.\\.claude\\hooks\\belay-runner.cmd' : './.claude/hooks/belay-runner';
    return [base, hookName, ...args].join(' ');
}
export function getClaudeManagedHookGroups(platform = process.platform) {
    const toolGate = runnerCommand(platform, 'belay-tool-gate', 'PreToolUse');
    const shellGate = runnerCommand(platform, 'belay-shell-gate');
    const approvalGate = runnerCommand(platform, 'belay-before-submit');
    const auditHook = runnerCommand(platform, 'belay-audit', 'PostToolUse');
    return {
        PreToolUse: [
            {
                matcher: 'Bash',
                hooks: [{ type: 'command', command: shellGate }],
            },
            {
                matcher: 'Task',
                hooks: [{ type: 'command', command: toolGate }],
            },
            {
                matcher: 'Write|Edit|Delete',
                hooks: [{ type: 'command', command: toolGate }],
            },
        ],
        UserPromptSubmit: [
            {
                hooks: [{ type: 'command', command: approvalGate }],
            },
        ],
        PostToolUse: [
            {
                hooks: [{ type: 'command', command: auditHook }],
            },
        ],
    };
}
export function getClaudeManagedHookEntries(platform = process.platform) {
    const groups = getClaudeManagedHookGroups(platform);
    const entries = [];
    for (const [event, groupList] of Object.entries(groups)) {
        for (const group of groupList) {
            const command = group.hooks[0]?.command;
            if (!command) {
                continue;
            }
            entries.push({
                event,
                definition: {
                    command,
                    placement: 'prepend',
                    matcher: group.matcher,
                },
            });
        }
    }
    return entries;
}
