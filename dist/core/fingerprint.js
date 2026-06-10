import { createHash } from 'node:crypto';
export function canonicalStringify(value) {
    if (value === null || typeof value !== 'object') {
        return JSON.stringify(value);
    }
    if (Array.isArray(value)) {
        return `[${value.map((item) => canonicalStringify(item)).join(',')}]`;
    }
    const entries = Object.entries(value).sort(([left], [right]) => left.localeCompare(right));
    return `{${entries.map(([key, child]) => `${JSON.stringify(key)}:${canonicalStringify(child)}`).join(',')}}`;
}
export function hashValue(value) {
    return createHash('sha256').update(value).digest('hex');
}
export function shellFingerprint(cwdRelative, normalizedCommand) {
    return hashValue(`shell:${cwdRelative}:${normalizedCommand}`);
}
export function subagentFingerprint(kind, scrubbed, repoRoot) {
    return hashValue(`subagent:${kind}:${canonicalStringify(scrubbed)}:${repoRoot}`);
}
export function toolFingerprint(toolName, scrubbed, repoRoot) {
    return hashValue(`tool:${toolName}:${canonicalStringify(scrubbed)}:${repoRoot}`);
}
