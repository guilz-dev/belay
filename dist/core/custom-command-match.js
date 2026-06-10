/** Match config allow/deny patterns against a normalized command or segment key (exact only). */
export function matchesCustomCommand(normalizedCommand, key, pattern) {
    const trimmed = pattern.trim();
    if (!trimmed) {
        return false;
    }
    return normalizedCommand === trimmed || key === trimmed;
}
