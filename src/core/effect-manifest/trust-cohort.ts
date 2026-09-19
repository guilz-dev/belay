import { existsSync, readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'

import { repoLocalStateDirFor } from '../../config-io.js'
import type { BelayConfigV4 } from '../config.js'
import { canonicalStringify, hashValue } from '../fingerprint.js'
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
      for (const rule of raw.trustedRules) {
        if (typeof rule.ruleFingerprint === 'string' && rule.ruleFingerprint.length > 0) {
          fingerprints.add(rule.ruleFingerprint)
        }
      }
    } catch {
      // Malformed trust records are ignored for cohort hashing; doctor reports them separately.
    }
  }
  return [...fingerprints].sort()
}

export function hashEffectManifestTrustCohort(repoRoot: string, config: BelayConfigV4): string {
  return hashValue(canonicalStringify(collectActiveEffectManifestRuleFingerprints(repoRoot, config)))
}
