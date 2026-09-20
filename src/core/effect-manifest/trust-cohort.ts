import { existsSync, readdirSync } from 'node:fs'
import path from 'node:path'

import { repoLocalStateDirFor } from '../../config-io.js'
import type { BelayConfigV4 } from '../config.js'
import { canonicalStringify, hashValue } from '../fingerprint.js'
import { canonicalPath } from '../path-utils.js'
import { ruleFingerprint } from './codec.js'
import { commandIdentityFingerprint } from './command-identity.js'
import { verifyStoredExecutableIdentity } from './executable-identity.js'
import { readEffectManifestFromPath } from './load-manifest-sync.js'
import { readEffectManifestTrustFromPathSync } from './load-trust-sync.js'
import { manifestFilePath } from './paths.js'
import { effectManifestTrustDir } from './trust-store.js'
import { manifestAuthorityIssues, ruleIsTrustEligible } from './validate.js'

export function collectActiveEffectManifestRuleFingerprints(
  repoRoot: string,
  config: BelayConfigV4,
): string[] {
  const canonicalRepoRoot = canonicalPath(repoRoot)
  const trustDir = effectManifestTrustDir(
    config,
    repoLocalStateDirFor(canonicalRepoRoot, config),
    canonicalRepoRoot,
  )
  if (!existsSync(trustDir)) {
    return []
  }
  const fingerprints = new Set<string>()
  for (const entry of readdirSync(trustDir)) {
    if (!entry.endsWith('.json')) {
      continue
    }
    try {
      const raw = readEffectManifestTrustFromPathSync(path.join(trustDir, entry))
      if (!raw || raw.repoRoot !== canonicalRepoRoot) {
        continue
      }
      const manifest = readEffectManifestFromPath(raw.manifestPath)
      if (!manifest) {
        continue
      }
      if (manifestAuthorityIssues(manifest).length > 0) {
        continue
      }
      if (verifyStoredExecutableIdentity(manifest.command) !== 'ok') {
        continue
      }
      if (commandIdentityFingerprint(manifest.command) !== raw.commandIdentityFingerprint) {
        continue
      }
      const expectedManifestPath = manifestFilePath(canonicalRepoRoot, manifest.command.basename)
      if (path.resolve(raw.manifestPath) !== path.resolve(expectedManifestPath)) {
        continue
      }
      for (const trusted of raw.trustedRules) {
        const rule = manifest.rules.find((candidate) => candidate.id === trusted.id)
        if (!rule || !ruleIsTrustEligible(rule)) {
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
