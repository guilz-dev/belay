import { hashValue } from '../fingerprint.js'

export function verdictFingerprint(cwdRelative: string, commandRedacted: string): string {
  return hashValue(`v2:${cwdRelative}:${commandRedacted}`)
}
