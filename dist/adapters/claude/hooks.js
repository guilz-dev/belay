import path from 'node:path';
import { buildRunnerInvocation } from '../layouts/scope.js';
export function getClaudeManagedHookGroups(platform, hooksDir, repoRoot) {
    const runner = (hookName, ...args) => buildRunnerInvocation(platform, hooksDir, repoRoot, hookName, ...args);
    const toolGate = runner('belay-tool-gate', 'PreToolUse');
    const shellGate = runner('belay-shell-gate');
    const approvalGate = runner('belay-before-submit');
    const auditHook = runner('belay-audit', 'PostToolUse');
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
export function getClaudeManagedHookEntries(platform = process.platform, hooksDir, repoRoot) {
    const resolvedRepo = path.resolve(repoRoot ?? process.cwd());
    const resolvedHooksDir = hooksDir ?? path.join(resolvedRepo, '.claude', 'hooks');
    const groups = getClaudeManagedHookGroups(platform, resolvedHooksDir, resolvedRepo);
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
