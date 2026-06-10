const UUID_PATTERN = /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/gi;
const TIMESTAMP_PATTERN = /\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z\b/g;
const APPROVAL_ID_PATTERN = /\bbelay_[a-z0-9]{8,}\b/gi;
const TOKEN_PREFIX_PATTERN = /\/belay-approve\s+\S+/gi;
export function scrubString(value) {
    return value
        .replace(UUID_PATTERN, '<uuid>')
        .replace(TIMESTAMP_PATTERN, '<timestamp>')
        .replace(APPROVAL_ID_PATTERN, '<approval-id>')
        .replace(TOKEN_PREFIX_PATTERN, '/belay-approve <approval-id>');
}
export function scrubValue(value) {
    if (typeof value === 'string') {
        return scrubString(value);
    }
    if (Array.isArray(value)) {
        return value.map((item) => scrubValue(item));
    }
    if (value && typeof value === 'object') {
        const result = {};
        for (const [key, child] of Object.entries(value)) {
            result[key] = scrubValue(child);
        }
        return result;
    }
    return value;
}
