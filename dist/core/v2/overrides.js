import { matchesCustomCommand } from '../custom-command-match.js';
export function matchesCustomPatterns(command, segment, patterns) {
    if (!patterns || patterns.length === 0) {
        return false;
    }
    const normalized = command.trim();
    return patterns.some((pattern) => matchesCustomCommand(normalized, segment.key, pattern) ||
        matchesCustomCommand(segment.normalized, segment.key, pattern));
}
export function customAllowMatch(command, segment, context) {
    return matchesCustomPatterns(command, segment, context.customAllowCommands);
}
export function customExternalMatch(command, segment, context) {
    return matchesCustomPatterns(command, segment, context.customExternalCommands);
}
export function allowFromCustomOverride(opacity) {
    return {
        permission: 'allow',
        location: 'repo_local',
        opacity,
        effect: 'unknown',
        confidence: 'deterministic',
        reason: 'custom_allow',
        signals: ['custom_allow'],
    };
}
export function askFromCustomExternal(opacity) {
    return {
        permission: 'ask',
        location: 'external',
        opacity,
        effect: 'remote_mutation',
        confidence: 'deterministic',
        reason: 'custom_external',
        signals: ['custom_external'],
    };
}
