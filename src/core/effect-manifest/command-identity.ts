import { canonicalStringify, hashValue } from '../fingerprint.js'
import type { EffectManifestV1 } from './types.js'

export function commandIdentityFingerprint(command: EffectManifestV1['command']): string {
  return hashValue(canonicalStringify(command))
}
