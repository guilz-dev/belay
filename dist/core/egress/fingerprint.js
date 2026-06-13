import { hashValue } from '../fingerprint.js';
export function egressFingerprint(repoRoot, host, port, method, hasPayload = false) {
    const payloadTag = hasPayload ? ':payload' : '';
    return hashValue(`egress:${repoRoot}:${host.toLowerCase()}:${port}:${method.toUpperCase()}${payloadTag}`);
}
function formatHostPort(host, port) {
    const normalized = host.toLowerCase();
    const hostLabel = normalized.includes(':') ? `[${normalized}]` : normalized;
    return `${hostLabel}:${port}`;
}
export function egressSummary(host, port, method = 'CONNECT', hasPayload = false) {
    return `${method} ${formatHostPort(host, port)}${hasPayload ? ' (payload)' : ''}`;
}
export function parseHostFromSummary(summary) {
    const trimmed = summary.trim();
    const methodMatch = trimmed.match(/^(CONNECT|GET|POST|PUT|DELETE|HEAD|PATCH|OPTIONS)\s+(.+?)(?:\s+\(payload\))?$/i);
    if (!methodMatch?.[2]) {
        try {
            return new URL(trimmed).hostname.toLowerCase();
        }
        catch {
            return null;
        }
    }
    const target = methodMatch[2].trim();
    const bracketMatch = target.match(/^\[([^\]]+)\]:(\d+)$/);
    if (bracketMatch?.[1]) {
        return bracketMatch[1].toLowerCase();
    }
    const colonIndex = target.lastIndexOf(':');
    if (colonIndex > 0) {
        return target.slice(0, colonIndex).toLowerCase();
    }
    return target.toLowerCase();
}
