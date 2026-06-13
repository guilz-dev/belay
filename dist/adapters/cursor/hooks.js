import { getManagedHookEntries } from '../../defaults.js';
function entryMatches(existing, expected) {
    return existing.command === expected.command && existing.matcher === expected.matcher;
}
function mergeHookEntry(current, expected, placement) {
    const entries = Array.isArray(current) ? [...current] : [];
    const filtered = entries.filter((entry) => !entryMatches(entry, expected));
    if (placement === 'prepend') {
        return [expected, ...filtered];
    }
    return [...filtered, expected];
}
export function mergeCursorHooksFile(current, platform, hooksDir, repoRoot) {
    const next = {
        version: current.version || 1,
        hooks: { ...current.hooks },
    };
    const managedEntries = getManagedHookEntries(platform, hooksDir, repoRoot);
    for (const { event, definition } of managedEntries) {
        next.hooks[event] = mergeHookEntry(next.hooks[event], {
            command: definition.command,
            matcher: definition.matcher,
        }, definition.placement);
    }
    return next;
}
