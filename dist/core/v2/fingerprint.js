import { hashValue } from '../fingerprint.js';
export function verdictFingerprint(cwdRelative, commandRedacted) {
    return hashValue(`v2:${cwdRelative}:${commandRedacted}`);
}
