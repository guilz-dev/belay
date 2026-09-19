import { canonicalStringify } from '../fingerprint.js'
import { parseEffectManifestV1 } from './codec.js'
import { verifyStoredExecutableIdentity } from './executable-identity.js'
import type { EffectManifestRuleV1, EffectManifestV1 } from './types.js'

export function ruleIsTrustEligible(rule: EffectManifestRuleV1): boolean {
  return !rule.contract.effects.some((effect) => effect.tag === 'indeterminate')
}

export interface ManifestValidationIssue {
  code: string
  message: string
  ruleId?: string
}

export interface ManifestValidationReport {
  ok: boolean
  manifest: EffectManifestV1 | null
  issues: ManifestValidationIssue[]
  trustEligibleRuleIds: string[]
}

function matcherKey(rule: EffectManifestRuleV1): string {
  return canonicalStringify(rule.matcher.argv)
}

function detectOverlappingMatchers(
  rules: readonly EffectManifestRuleV1[],
): ManifestValidationIssue[] {
  const issues: ManifestValidationIssue[] = []
  const seen = new Map<string, string>()
  for (const rule of rules) {
    const key = matcherKey(rule)
    const prior = seen.get(key)
    if (prior) {
      issues.push({
        code: 'matcher_overlap',
        message: `Rules ${prior} and ${rule.id} have overlapping matchers.`,
        ruleId: rule.id,
      })
      continue
    }
    seen.set(key, rule.id)
  }
  return issues
}

function validateEffectTemplates(
  rules: readonly EffectManifestRuleV1[],
): ManifestValidationIssue[] {
  const issues: ManifestValidationIssue[] = []
  for (const rule of rules) {
    for (const effect of rule.contract.effects) {
      if (typeof effect.tag !== 'string' || typeof effect.action !== 'string') {
        issues.push({
          code: 'invalid_effect_template',
          message: `Rule ${rule.id} has an invalid effect template.`,
          ruleId: rule.id,
        })
      }
    }
  }
  return issues
}

export function validateEffectManifestDocument(
  raw: unknown,
  _repoRoot: string,
): ManifestValidationReport {
  const manifest = parseEffectManifestV1(raw)
  if (!manifest) {
    return {
      ok: false,
      manifest: null,
      issues: [{ code: 'schema_invalid', message: 'Manifest schema is invalid.' }],
      trustEligibleRuleIds: [],
    }
  }
  const issues = [
    ...detectOverlappingMatchers(manifest.rules),
    ...validateEffectTemplates(manifest.rules),
  ]
  const identity = verifyStoredExecutableIdentity(manifest.command)
  if (identity !== 'ok') {
    issues.push({
      code: 'executable_identity',
      message:
        identity === 'missing'
          ? 'Executable is missing on disk.'
          : identity === 'not_regular'
            ? 'Executable is not a regular file.'
            : 'Executable identity no longer matches the manifest.',
    })
  }
  const trustEligibleRuleIds = manifest.rules.filter(ruleIsTrustEligible).map((rule) => rule.id)
  return {
    ok: issues.length === 0,
    manifest,
    issues,
    trustEligibleRuleIds,
  }
}
