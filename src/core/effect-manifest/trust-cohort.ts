import { existsSync, readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'

import { repoLocalStateDirFor } from '../../config-io.js'
import type { BelayConfigV4 } from '../config.js'
import { canonicalStringify, hashValue } from '../fingerprint.js'
import { ruleFingerprint } from './codec.js'
import { readEffectManifestFromPath } from './load-manifest-sync.js'
import { effectManifestTrustDir } from './trust-store.js'
import type { EffectManifestTrustRecordV1 } from './types.js'

export function collectActiveEffectManifestRuleFingerprints(
  repoRoot: string,
  config: BelayConfigV4,
): string[] {
  const trustDir = effectManifestTrustDir(config, repoLocalStateDirFor(repoRoot, config))
  if (!existsSync(trustDir)) {
    return []
  }
  const fingerprints = new Set<string>()
  for (const entry of readdirSync(trustDir)) {
    if (!entry.endsWith('.json')) {
      continue
    }
    try {
      const raw = JSON.parse(
        readFileSync(path.join(trustDir, entry), 'utf8'),
      ) as EffectManifestTrustRecordV1
      if (
        raw.schemaVersion !== 1 ||
        raw.repoRoot !== repoRoot ||
        !Array.isArray(raw.trustedRules)
      ) {
        continue
      }
      const manifest = readEffectManifestFromPath(raw.manifestPath)
      if (!manifest) {
        continue
      }
      for (const trusted of raw.trustedRules) {
        const rule = manifest.rules.find((candidate) => candidate.id === trusted.id)
        if (!rule) {
          continue
        }
        const fingerprint = ruleFingerprint(manifest, rule)
        if (fingerprint === trusted.ruleFingerprint) {
          fingerprints.add(fingerprint)
        }
      }
    } catch {
      // Malformed trust records are ignored for cohort hashing; doctor reports them separately.
    }
  }
  return [...fingerprints].sort()
}

export function hashEffectManifestTrustCohort(repoRoot: string, config: BelayConfigV4): string {
  return hashValue(
    canonicalStringify(collectActiveEffectManifestRuleFingerprints(repoRoot, config)),
  )
}
