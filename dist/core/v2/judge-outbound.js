import { matchesSensitivePath } from '../glob.js';
import { scrubString } from '../scrub.js';
const PATH_LIKE = /(?:^|[\s"'`=])(~\/[^\s"'`]+|\/[^\s"'`]+|\.\/[^\s"'`]+|\.\.\/[^\s"'`]+|[A-Za-z]:\\[^\s"'`]+)/g;
const REDACTED_PLACEHOLDER = /^(?:<redacted>|\[REDACTED\]|<secret>|<high-entropy>|<approval-id>)$/i;
function hasResidualBearerToken(text) {
    for (const match of text.matchAll(/\bBearer\s+(\S+)/gi)) {
        const token = match[1] ?? '';
        if (!REDACTED_PLACEHOLDER.test(token)) {
            return true;
        }
    }
    return false;
}
function hasResidualApiKey(text) {
    return /\bsk-(?![^\s]*<redacted>)[A-Za-z0-9_-]{4,}/i.test(text);
}
function redactSensitivePathToken(token, sensitivePaths) {
    const trimmed = token.replace(/^['"`]+|['"`]+$/g, '');
    const normalized = trimmed.replaceAll('\\', '/');
    if (!matchesSensitivePath(normalized, sensitivePaths)) {
        return token;
    }
    const segments = normalized.split('/');
    const basename = segments.at(-1) ?? normalized;
    if (segments.length > 1) {
        return token.replace(basename, '[REDACTED]');
    }
    return '[REDACTED]';
}
export function scrubOutboundForJudge(text, options) {
    try {
        let scrubbed = scrubString(text, {
            ...options.scrubOptions,
            maskHighEntropyStrings: options.scrubOptions.maskHighEntropyStrings !== false,
        });
        scrubbed = scrubbed.replace(PATH_LIKE, (match, pathToken) => {
            const redacted = redactSensitivePathToken(pathToken, options.sensitivePaths);
            return match.replace(pathToken, redacted);
        });
        if (hasResidualApiKey(scrubbed) || hasResidualBearerToken(scrubbed)) {
            return { ok: false, reason: 'residual_secret_detected' };
        }
        return { ok: true, text: scrubbed };
    }
    catch (error) {
        const reason = error instanceof Error ? error.message : 'scrub_failed';
        return { ok: false, reason };
    }
}
