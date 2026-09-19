import { canonicalStringify, hashValue } from '../fingerprint.js'
import { parseEffectManifestV1 } from './codec.js'
import type { EffectManifestRuleV1, EffectManifestV1 } from './types.js'

export function deriveRuleIdFromArgv(argv: readonly string[]): string {
  return `argv-${hashValue(canonicalStringify(argv)).slice(0, 12)}`
}

export function buildCandidateRule(argv: readonly string[]): EffectManifestRuleV1 {
  const generatedAt = new Date().toISOString()
  return {
    id: deriveRuleIdFromArgv(argv),
    matcher: {
      argv: argv.map((value) => ({ kind: 'literal', value })),
    },
    contract: {
      processOperation: 'inspect',
      effects: [
        {
          tag: 'indeterminate',
          action: 'unknown',
          resource: { reason: 'manual_completion_required' },
        },
      ],
    },
    assertion: 'complete-upper-bound',
    inference: {
      method: 'static',
      generatedAt,
      generatorVersion: 'belay-manifest-infer-v1',
      evidence: [],
      warnings: [
        'Complete the effect contract manually before trusting this complete upper bound.',
      ],
    },
  }
}

export function appendCandidateRule(
  manifest: EffectManifestV1,
  candidate: EffectManifestRuleV1,
): { ok: true; manifest: EffectManifestV1 } | { ok: false; reason: string } {
  if (manifest.rules.some((rule) => rule.id === candidate.id)) {
    return { ok: false, reason: 'rule_id_exists' }
  }
  const candidateKey = canonicalStringify(candidate.matcher.argv)
  if (manifest.rules.some((rule) => canonicalStringify(rule.matcher.argv) === candidateKey)) {
    return { ok: false, reason: 'matcher_exists' }
  }
  return {
    ok: true,
    manifest: {
      ...manifest,
      rules: [...manifest.rules, candidate],
    },
  }
}

export function parseStoredManifest(raw: unknown): EffectManifestV1 | null {
  return parseEffectManifestV1(raw)
}
