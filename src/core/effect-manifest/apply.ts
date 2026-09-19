import { existsSync, readFileSync } from 'node:fs'

import type { ShellEffectRequirement } from '../effect-ir/shell-build.js'
import { isGrammarUnknownOnly } from '../effect-ir/shell-lower/argv-delegate-gate.js'
import { processRequirement } from '../effect-ir/shell-lower/requirement.js'
import { manifestFingerprint, parseEffectManifestV1, ruleFingerprint } from './codec.js'
import { loadEffectManifestTrustSync } from './load-trust-sync.js'
import { findUniqueMatchingRule } from './matcher.js'
import { manifestFilePath, normalizeManifestBasename } from './paths.js'
import type {
  EffectManifestApplicationRole,
  EffectManifestAuditV1,
  EffectManifestTrustRecordV1,
  EffectManifestV1,
} from './types.js'

const MANIFEST_EVIDENCE_BASIS = 'effect_manifest.trusted_complete_upper_bound'

const NON_REPLACEABLE_SIGNAL_PREFIXES = ['parser.', 'shell.']

export interface ApplyEffectManifestParams {
  repoRoot: string
  head: string
  argv: readonly string[]
  requirements: ShellEffectRequirement[]
  segmentCompleteness: 'complete' | 'partial'
  role: EffectManifestApplicationRole
  trustRecord: EffectManifestTrustRecordV1 | null
}

export interface ApplyEffectManifestResult {
  requirements: ShellEffectRequirement[]
  audit?: EffectManifestAuditV1
  telemetrySignals: string[]
}

function requirementsHaveNonReplaceableIndeterminate(
  requirements: readonly ShellEffectRequirement[],
): boolean {
  return requirements.some((entry) => {
    if (entry.tag !== 'indeterminate') {
      return false
    }
    return entry.evidence.signals.some(
      (signal) =>
        signal === 'parser.disagreement' ||
        NON_REPLACEABLE_SIGNAL_PREFIXES.some((prefix) => signal.startsWith(prefix)),
    )
  })
}

function loadManifest(repoRoot: string, basename: string): EffectManifestV1 | null {
  const filePath = manifestFilePath(repoRoot, basename)
  if (!existsSync(filePath)) {
    return null
  }
  try {
    const raw = JSON.parse(readFileSync(filePath, 'utf8')) as unknown
    return parseEffectManifestV1(raw)
  } catch {
    return null
  }
}

function instantiateRequirements(
  rule: EffectManifestV1['rules'][number],
  head: string,
  segment: string,
): ShellEffectRequirement[] {
  const operation =
    rule.contract.processOperation === 'signal' ? 'spawn' : rule.contract.processOperation
  const process = processRequirement(head, operation, segment, [MANIFEST_EVIDENCE_BASIS])
  process.evidence = {
    level: 'certain',
    signals: [MANIFEST_EVIDENCE_BASIS],
    basis: [MANIFEST_EVIDENCE_BASIS],
  }
  const effects = rule.contract.effects.flatMap((template) => {
    if (template.tag === 'indeterminate') {
      return []
    }
    return [
      {
        tag: template.tag,
        action: template.action,
        resource: template.resource,
        evidence: {
          level: 'certain' as const,
          signals: [MANIFEST_EVIDENCE_BASIS],
          basis: [MANIFEST_EVIDENCE_BASIS],
        },
        provenance: { segment },
      } as unknown as ShellEffectRequirement,
    ]
  })
  if (effects.length === 0 && rule.contract.effects.length === 0) {
    return [process]
  }
  return [process, ...effects]
}

function trustedRule(
  manifest: EffectManifestV1,
  repoRoot: string,
  trustRecord: EffectManifestTrustRecordV1 | null,
  rule: EffectManifestV1['rules'][number],
): boolean {
  const record =
    trustRecord ?? loadEffectManifestTrustSync(repoRoot, manifest.command.canonicalPath)
  if (!record || record.repoRoot !== repoRoot) {
    return false
  }
  const fingerprint = ruleFingerprint(manifest, rule)
  return record.trustedRules.some(
    (entry) => entry.id === rule.id && entry.ruleFingerprint === fingerprint,
  )
}

export function applyEffectManifest(params: ApplyEffectManifestParams): ApplyEffectManifestResult {
  const basename = normalizeManifestBasename(params.head)
  const segment = params.requirements[0]?.provenance?.segment ?? params.head
  const baseAudit = (
    partial: Omit<EffectManifestAuditV1, 'commandBasename' | 'manifestFingerprint'> & {
      manifestFingerprint?: string
    },
  ): EffectManifestAuditV1 => ({
    commandBasename: basename ?? params.head,
    manifestFingerprint: partial.manifestFingerprint ?? '',
    ...partial,
  })

  if (
    params.segmentCompleteness !== 'complete' ||
    !isGrammarUnknownOnly(params.requirements, params.head) ||
    requirementsHaveNonReplaceableIndeterminate(params.requirements)
  ) {
    return { requirements: params.requirements, telemetrySignals: [] }
  }

  if (!basename) {
    return {
      requirements: params.requirements,
      audit: baseAudit({
        manifestFingerprint: '',
        trust: 'invalid',
        outcome: 'unavailable',
        reason: 'ineligible_basename',
      }),
      telemetrySignals: [],
    }
  }

  const manifest = loadManifest(params.repoRoot, basename)
  if (!manifest) {
    return {
      requirements: params.requirements,
      audit: baseAudit({
        manifestFingerprint: '',
        trust: 'missing',
        outcome: 'unmatched',
        reason: 'no_manifest',
      }),
      telemetrySignals: [],
    }
  }

  const fingerprint = manifestFingerprint(manifest)
  const argv = params.argv.slice(1)
  const matched = findUniqueMatchingRule(argv, manifest.rules)
  if (!matched || !trustedRule(manifest, params.repoRoot, params.trustRecord, matched)) {
    return {
      requirements: params.requirements,
      audit: baseAudit({
        manifestFingerprint: fingerprint,
        trust: params.trustRecord ? 'stale' : 'missing',
        outcome: 'unmatched',
        reason: matched ? 'rule_not_trusted' : 'no_rule_match',
        ...(matched ? { ruleId: matched.id } : {}),
      }),
      telemetrySignals: [],
    }
  }

  const ruleFp = ruleFingerprint(manifest, matched)
  const audit: EffectManifestAuditV1 = baseAudit({
    manifestFingerprint: fingerprint,
    ruleId: matched.id,
    ruleFingerprint: ruleFp,
    trust: 'trusted',
    outcome: params.role === 'telemetry-only' ? 'telemetry-only' : 'matched',
    reason: params.role === 'telemetry-only' ? 'shadow_candidate_match' : 'trusted_rule_match',
  })

  if (params.role === 'telemetry-only') {
    return {
      requirements: params.requirements,
      audit,
      telemetrySignals: ['effect_manifest.shadow_candidate_matched'],
    }
  }

  return {
    requirements: instantiateRequirements(matched, params.head, segment),
    audit,
    telemetrySignals: ['effect_manifest.matched'],
  }
}
