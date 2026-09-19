import { existsSync, readFileSync } from 'node:fs'

import { repoLocalStateDirFor } from '../../config-io.js'
import type { BelayConfigV3 } from '../config.js'
import { effectManifestTrustRecordPath } from './trust-store.js'
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
  if (!existsSync(filePath)) {
    return null
  }
  try {
    const raw = JSON.parse(readFileSync(filePath, 'utf8')) as EffectManifestTrustRecordV1
    if (raw.schemaVersion !== 1 || raw.repoRoot !== repoRoot) {
      return null
    }
    return raw
  } catch {
    return null
  }
}
