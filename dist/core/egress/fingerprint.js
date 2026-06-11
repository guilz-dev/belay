import { hashValue } from '../fingerprint.js';
export function egressFingerprint(repoRoot, host, port) {
    return hashValue(`egress:${repoRoot}:${host.toLowerCase()}:${port}`);
}
export function egressSummary(host, port, method = 'CONNECT') {
    return `${method} ${host.toLowerCase()}:${port}`;
}
export function parseHostFromSummary(summary) {
    const connectMatch = summary.match(/^(?:CONNECT|GET|POST|PUT|DELETE|HEAD)\s+([^:\s/]+)/i);
    if (connectMatch?.[1]) {
        return connectMatch[1].toLowerCase();
    }
    try {
        const url = new URL(summary.trim());
        return url.hostname.toLowerCase();
    }
    catch {
        return null;
    }
}
