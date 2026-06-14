const UUID_PATTERN = /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/gi;
const TIMESTAMP_PATTERN = /\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z\b/g;
const APPROVAL_ID_PATTERN = /\bbelay_[a-z0-9]{8,}\b/gi;
const TOKEN_PREFIX_PATTERN = /\/belay-approve\s+\S+/gi;
const BEARER_PATTERN = /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}\b/gi;
const AUTH_HEADER_PATTERN = /(?<!["'])\bAuthorization:\s*(?:Bearer|Basic|Token)?\s*\S+/gi;
const DOUBLE_QUOTED_AUTH_HEADER_PATTERN = /"Authorization:\s*[^"]*"/gi;
const SINGLE_QUOTED_AUTH_HEADER_PATTERN = /'Authorization:\s*[^']*'/gi;
const GENERIC_AUTH_HEADER_PATTERN = /(?<!["'])\b(?:X-Api-Key|X-Auth-Token|Private-Token):\s*\S+/gi;
const DOUBLE_QUOTED_GENERIC_AUTH_HEADER_PATTERN = /"(X-Api-Key|X-Auth-Token|Private-Token):\s*[^"]*"/gi;
const SINGLE_QUOTED_GENERIC_AUTH_HEADER_PATTERN = /'(X-Api-Key|X-Auth-Token|Private-Token):\s*[^']*'/gi;
const KEY_VALUE_SECRET_PATTERN = /\b(api[_-]?key|token|secret|password|passwd|credential)\b\s*[:=]\s*['"]?[^\s'"]{4,}/gi;
const URL_CREDENTIALS_PATTERN = /\b([A-Za-z][A-Za-z0-9+.-]*:\/\/)([^/\s:@]+):([^@\s/]+)@/g;
const MYSQL_INLINE_PASSWORD_PATTERN = /(\s-p)([^\s]+)/g;
const HIGH_ENTROPY_PATTERN = /\b[A-Za-z0-9+/]{40,}={0,2}\b/g;
const DEFAULT_SCRUB_OPTIONS = {
    maskApprovalIds: true,
    maskBearerTokens: true,
    maskAuthHeaders: true,
    maskKeyValueSecrets: true,
    maskHighEntropyStrings: true,
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
    let scrubbed = value.replace(UUID_PATTERN, '<uuid>').replace(TIMESTAMP_PATTERN, '<timestamp>');
    if (resolved.maskApprovalIds) {
        scrubbed = scrubbed
            .replace(APPROVAL_ID_PATTERN, '<approval-id>')
            .replace(TOKEN_PREFIX_PATTERN, '/belay-approve <approval-id>');
    }
    if (resolved.maskBearerTokens) {
        scrubbed = scrubbed.replace(BEARER_PATTERN, 'Bearer <redacted>');
    }
    if (resolved.maskAuthHeaders) {
        scrubbed = scrubbed
            .replace(DOUBLE_QUOTED_AUTH_HEADER_PATTERN, '"Authorization: <redacted>"')
            .replace(SINGLE_QUOTED_AUTH_HEADER_PATTERN, "'Authorization: <redacted>'")
            .replace(DOUBLE_QUOTED_GENERIC_AUTH_HEADER_PATTERN, (_match, header) => `"${header}: <redacted>"`)
            .replace(SINGLE_QUOTED_GENERIC_AUTH_HEADER_PATTERN, (_match, header) => `'${header}: <redacted>'`)
            .replace(AUTH_HEADER_PATTERN, 'Authorization: <redacted>')
            .replace(GENERIC_AUTH_HEADER_PATTERN, (match) => {
            const separatorIndex = match.indexOf(':');
            return `${match.slice(0, separatorIndex + 1)} <redacted>`;
        });
    }
    if (resolved.maskKeyValueSecrets) {
        scrubbed = scrubbed
            .replace(URL_CREDENTIALS_PATTERN, '$1<redacted>:<redacted>@')
            .replace(MYSQL_INLINE_PASSWORD_PATTERN, '$1<redacted>');
        scrubbed = scrubbed.replace(KEY_VALUE_SECRET_PATTERN, (match) => {
            const separatorMatch = match.match(/\s*[:=]\s*/);
            if (!separatorMatch || separatorMatch.index === undefined) {
                return '<secret>';
            }
            return `${match.slice(0, separatorMatch.index)}${separatorMatch[0]}<redacted>`;
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
