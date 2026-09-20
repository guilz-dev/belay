import { existsSync, readFileSync, statSync } from 'node:fs'

import { repoLocalStateDirFor } from '../../config-io.js'
import type { BelayConfigV3 } from '../config.js'
import { canonicalPath } from '../path-utils.js'
import {
  effectManifestTrustRecordPath,
  MAX_EFFECT_MANIFEST_TRUST_BYTES,
  parseEffectManifestTrustRecord,
} from './trust-store.js'
import type { EffectManifestTrustRecordV1 } from './types.js'

export function loadEffectManifestTrustSync(
  repoRoot: string,
  canonicalExecutablePath: string,
  config: BelayConfigV3,
): EffectManifestTrustRecordV1 | null {
  const repoLocalStateDir = repoLocalStateDirFor(repoRoot, config)
  const filePath = effectManifestTrustRecordPath(
    config,
    repoLocalStateDir,
    repoRoot,
    canonicalExecutablePath,
  )
  const raw = readEffectManifestTrustFromPathSync(filePath)
  return raw?.repoRoot === canonicalPath(repoRoot) ? raw : null
}

export function readEffectManifestTrustFromPathSync(
  filePath: string,
): EffectManifestTrustRecordV1 | null {
  if (!existsSync(filePath)) {
    return null
  }
  try {
    const stat = statSync(filePath)
    if (!stat.isFile() || stat.size > MAX_EFFECT_MANIFEST_TRUST_BYTES) {
      return null
    }
    const bytes = readFileSync(filePath)
    if (bytes.byteLength > MAX_EFFECT_MANIFEST_TRUST_BYTES) {
      return null
    }
    const raw = parseEffectManifestTrustRecord(
      new TextDecoder('utf-8', { fatal: true }).decode(bytes),
    )
    return raw
  } catch {
    return null
  }
}
