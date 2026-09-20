import { existsSync, readdirSync } from 'node:fs'
import path from 'node:path'

import { repoLocalStateDirFor } from '../../config-io.js'
import type { BelayConfigV4 } from '../config.js'
import { canonicalPath } from '../path-utils.js'
import { ruleFingerprint } from './codec.js'
import { commandIdentityFingerprint } from './command-identity.js'
import { readEffectManifestFromPath } from './load-manifest-sync.js'
import { readEffectManifestTrustFromPathSync } from './load-trust-sync.js'
import { manifestFilePath } from './paths.js'
import { effectManifestTrustDir } from './trust-store.js'
import type { EffectManifestV1 } from './types.js'
import { validateEffectManifestDocument } from './validate.js'

export function diagnoseEffectManifestHealth(
  repoRoot: string,
  config: BelayConfigV4,
): { issues: string[]; notes: string[] } {
  const canonicalRepoRoot = canonicalPath(repoRoot)
  const issues: string[] = []
  const notes: string[] = []
  const manifestDir = path.join(canonicalRepoRoot, '.belay', 'manifests')
  const manifests: EffectManifestV1[] = []

  if (existsSync(manifestDir)) {
    for (const entry of readdirSync(manifestDir)) {
      if (!entry.endsWith('.json')) {
        continue
      }
      const filePath = path.join(manifestDir, entry)
      try {
        const parsed = readEffectManifestFromPath(filePath)
        const report = validateEffectManifestDocument(parsed, canonicalRepoRoot)
        if (!report.manifest) {
          issues.push(`Effect manifest schema invalid: ${filePath}`)
          continue
        }
        manifests.push(report.manifest)
        if (!report.ok) {
          for (const issue of report.issues) {
            issues.push(`Effect manifest ${filePath}: ${issue.message}`)
          }
        }
      } catch {
        issues.push(`Effect manifest unreadable: ${filePath}`)
      }
    }
  }

  const trustDir = effectManifestTrustDir(
    config,
    repoLocalStateDirFor(canonicalRepoRoot, config),
    canonicalRepoRoot,
  )
  if (existsSync(trustDir)) {
    for (const entry of readdirSync(trustDir)) {
      if (!entry.endsWith('.json')) {
        continue
      }
      const filePath = path.join(trustDir, entry)
      try {
        const raw = readEffectManifestTrustFromPathSync(filePath)
        if (!raw) {
          issues.push(`Effect manifest trust record invalid: ${filePath}`)
          continue
        }
        if (raw.repoRoot !== canonicalRepoRoot) {
          continue
        }
        if (!existsSync(raw.manifestPath)) {
          issues.push(`Effect manifest trust record points to missing file: ${filePath}`)
          continue
        }
        const manifest = readEffectManifestFromPath(raw.manifestPath)
        if (!manifest) {
          issues.push(
            `Effect manifest trust record references invalid manifest: ${raw.manifestPath}`,
          )
          continue
        }
        const expectedPath = manifestFilePath(canonicalRepoRoot, manifest.command.basename)
        if (path.resolve(raw.manifestPath) !== path.resolve(expectedPath)) {
          issues.push(`Effect manifest trust record manifest path mismatch: ${filePath}`)
        }
        if (commandIdentityFingerprint(manifest.command) !== raw.commandIdentityFingerprint) {
          issues.push(
            `Effect manifest trust record executable identity is stale; re-trust after manifest edits (${filePath}).`,
          )
        }
        for (const trusted of raw.trustedRules) {
          const rule = manifest.rules.find((entry) => entry.id === trusted.id)
          if (!rule) {
            issues.push(
              `Effect manifest trust record references missing rule ${trusted.id} (${filePath}).`,
            )
            continue
          }
          const fingerprint = ruleFingerprint(manifest, rule)
          if (fingerprint !== trusted.ruleFingerprint) {
            issues.push(
              `Effect manifest trust is stale for rule ${trusted.id}; re-trust after manifest edits (${filePath}).`,
            )
          }
        }
      } catch {
        issues.push(`Effect manifest trust record unreadable: ${filePath}`)
      }
    }
  }

  if (manifests.length > 0) {
    notes.push(`Effect manifests: ${manifests.length} executable file(s) under ${manifestDir}`)
  }

  return { issues, notes }
}
