const UUID_PATTERN = /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/gi;
const TIMESTAMP_PATTERN = /\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z\b/g;
const APPROVAL_ID_PATTERN = /\bbelay_[a-z0-9]{8,}\b/gi;
const TOKEN_PREFIX_PATTERN = /\/belay-approve\s+\S+/gi;
const BEARER_PATTERN = /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}\b/gi;
const AUTH_HEADER_PATTERN = /\bAuthorization:\s*\S+/gi;
const KEY_VALUE_SECRET_PATTERN = /\b(api[_-]?key|token|secret|password|passwd|credential)\b\s*[:=]\s*['"]?[^\s'"]{4,}/gi;
const HIGH_ENTROPY_PATTERN = /\b[A-Za-z0-9+/]{40,}={0,2}\b/g;
const DEFAULT_SCRUB_OPTIONS = {
    maskApprovalIds: true,
    maskBearerTokens: true,
    maskAuthHeaders: true,
    maskKeyValueSecrets: true,
    maskHighEntropyStrings: false,
};
function resolvedScrubOptions(options = {}) {
    return {
        maskApprovalIds: options.maskApprovalIds !== false,
        maskBearerTokens: options.maskBearerTokens !== false,
        maskAuthHeaders: options.maskAuthHeaders !== false,
        maskKeyValueSecrets: options.maskKeyValueSecrets !== false,
        maskHighEntropyStrings: options.maskHighEntropyStrings === true,
    };
}
export function scrubString(value, options = {}) {
    const resolved = resolvedScrubOptions(options);
    let scrubbed = value
        .replace(UUID_PATTERN, '<uuid>')
        .replace(TIMESTAMP_PATTERN, '<timestamp>');
    if (resolved.maskApprovalIds) {
        scrubbed = scrubbed
            .replace(APPROVAL_ID_PATTERN, '<approval-id>')
            .replace(TOKEN_PREFIX_PATTERN, '/belay-approve <approval-id>');
    }
    if (resolved.maskBearerTokens) {
        scrubbed = scrubbed.replace(BEARER_PATTERN, 'Bearer <redacted>');
    }
    if (resolved.maskAuthHeaders) {
        scrubbed = scrubbed.replace(AUTH_HEADER_PATTERN, 'Authorization: <redacted>');
    }
    if (resolved.maskKeyValueSecrets) {
        scrubbed = scrubbed.replace(KEY_VALUE_SECRET_PATTERN, (match) => {
            const separatorIndex = Math.max(match.indexOf('='), match.indexOf(':'));
            if (separatorIndex === -1) {
                return '<secret>';
            }
            return `${match.slice(0, separatorIndex + 1)}<redacted>`;
        });
    }
    if (resolved.maskHighEntropyStrings) {
        scrubbed = scrubbed.replace(HIGH_ENTROPY_PATTERN, '<high-entropy>');
    }
    return scrubbed;
}
export function scrubValue(value, options = DEFAULT_SCRUB_OPTIONS) {
    if (typeof value === 'string') {
        return scrubString(value, options);
    }
    if (Array.isArray(value)) {
        return value.map((item) => scrubValue(item, options));
    }
    if (value && typeof value === 'object') {
        const result = {};
        for (const [key, child] of Object.entries(value)) {
            result[key] = scrubValue(child, options);
        }
        return result;
    }
    return value;
}
