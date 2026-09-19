import path from 'node:path'

import type { ProcessOperation } from '../capability/request.js'
import { type BelayConfigV3, mergeConfig } from '../config.js'
import type { ShellEffectRequirement } from '../effect-ir/shell-build.js'
import { isGrammarUnknownOnly } from '../effect-ir/shell-lower/argv-delegate-gate.js'
import { processRequirement } from '../effect-ir/shell-lower/requirement.js'
import { manifestFingerprint, ruleFingerprint } from './codec.js'
import { validateManifestEffectTemplate } from './effect-template.js'
import { verifyStoredExecutableIdentity } from './executable-identity.js'
import { invocationMatchesManifestCommand } from './invocation-identity.js'
import { loadEffectManifestSync } from './load-manifest-sync.js'
import { loadEffectManifestTrustSync } from './load-trust-sync.js'
import { findUniqueMatchingRule } from './matcher.js'
import { manifestFilePath, normalizeManifestBasename } from './paths.js'
import type {
  EffectManifestApplicationRole,
  EffectManifestAuditV1,
  EffectManifestTrustRecordV1,
  EffectManifestV1,
} from './types.js'
import { ruleIsTrustEligible } from './validate.js'

const MANIFEST_EVIDENCE_BASIS = 'effect_manifest.trusted_complete_upper_bound'

function requirementBlocksManifest(entry: ShellEffectRequirement): boolean {
  return entry.evidence.signals.some(
    (signal) =>
      signal === 'parser.disagreement' ||
      signal.startsWith('parser.') ||
      signal.startsWith('shell.'),
  )
}

export interface ApplyEffectManifestParams {
  repoRoot: string
  cwd: string
  pathEnv: string
  /** argv[0] as invoked (may include a path prefix). */
  invocationHead: string
  /** Decoder basename used for grammar_unknown matching. */
  decoderHead: string
  argv: readonly string[]
  requirements: ShellEffectRequirement[]
  segmentCompleteness: 'complete' | 'partial'
  role: EffectManifestApplicationRole
  frontendId?: EffectManifestAuditV1['frontendId']
  trustRecord: EffectManifestTrustRecordV1 | null
  /** When false, canonical lowering ignores manifests; telemetry-only may still observe. */
  gateConsumptionEnabled?: boolean
  belayConfig?: BelayConfigV3
}

export interface ApplyEffectManifestResult {
  requirements: ShellEffectRequirement[]
  audit?: EffectManifestAuditV1
  telemetrySignals: string[]
  /** True when a trusted rule replaced grammar_unknown on the canonical path. */
  matched: boolean
}

function requirementsBlockManifest(requirements: readonly ShellEffectRequirement[]): boolean {
  return requirements.some((entry) => requirementBlocksManifest(entry))
}

function ruleContractIsRuntimeAuthoritative(rule: EffectManifestV1['rules'][number]): boolean {
  return ruleIsTrustEligible(rule)
}

function instantiateRequirements(
  rule: EffectManifestV1['rules'][number],
  head: string,
  segment: string,
): ShellEffectRequirement[] | null {
  if (!ruleContractIsRuntimeAuthoritative(rule)) {
    return null
  }
  const operation: ProcessOperation = rule.contract.processOperation
  const process = processRequirement(head, operation, segment, [MANIFEST_EVIDENCE_BASIS])
  process.evidence = {
    level: 'certain',
    signals: [MANIFEST_EVIDENCE_BASIS],
    basis: [MANIFEST_EVIDENCE_BASIS],
  }
  const effects: ShellEffectRequirement[] = []
  for (const template of rule.contract.effects) {
    const validated = validateManifestEffectTemplate(template)
    if (!validated.ok) {
      return null
    }
    effects.push({
      tag: template.tag as ShellEffectRequirement['tag'],
      action: template.action as ShellEffectRequirement['action'],
      resource: validated.resource as ShellEffectRequirement['resource'],
      evidence: {
        level: 'certain',
        signals: [MANIFEST_EVIDENCE_BASIS],
        basis: [MANIFEST_EVIDENCE_BASIS],
      },
      provenance: { segment },
    })
  }
  if (effects.length === 0) {
    return [process]
  }
  return [process, ...effects]
}

function loadTrustRecord(
  manifest: EffectManifestV1,
  repoRoot: string,
  basename: string,
  trustRecord: EffectManifestTrustRecordV1 | null,
  belayConfig: BelayConfigV3,
): EffectManifestTrustRecordV1 | null {
  const record =
    trustRecord ??
    loadEffectManifestTrustSync(repoRoot, manifest.command.canonicalPath, belayConfig)
  if (!record || record.repoRoot !== repoRoot) {
    return null
  }
  const expectedManifestPath = manifestFilePath(repoRoot, basename)
  if (path.resolve(record.manifestPath) !== path.resolve(expectedManifestPath)) {
    return null
  }
  return record
}

function trustedRule(
  manifest: EffectManifestV1,
  repoRoot: string,
  basename: string,
  trustRecord: EffectManifestTrustRecordV1 | null,
  belayConfig: BelayConfigV3,
  rule: EffectManifestV1['rules'][number],
): boolean {
  const record = loadTrustRecord(manifest, repoRoot, basename, trustRecord, belayConfig)
  if (!record) {
    return false
  }
  const fingerprint = ruleFingerprint(manifest, rule)
  return record.trustedRules.some(
    (entry) => entry.id === rule.id && entry.ruleFingerprint === fingerprint,
  )
}

function resolveTrustAudit(
  manifest: EffectManifestV1,
  repoRoot: string,
  basename: string,
  trustRecord: EffectManifestTrustRecordV1 | null,
  belayConfig: BelayConfigV3,
  matchedRule: EffectManifestV1['rules'][number] | null,
): EffectManifestAuditV1['trust'] {
  if (!matchedRule) {
    return 'missing'
  }
  const record = loadTrustRecord(manifest, repoRoot, basename, trustRecord, belayConfig)
  if (!record) {
    return 'missing'
  }
  const fingerprint = ruleFingerprint(manifest, matchedRule)
  const entry = record.trustedRules.find((item) => item.id === matchedRule.id)
  if (!entry) {
    return 'missing'
  }
  return entry.ruleFingerprint !== fingerprint ? 'stale' : 'missing'
}

export function applyEffectManifest(params: ApplyEffectManifestParams): ApplyEffectManifestResult {
  const belayConfig = params.belayConfig ?? mergeConfig({})
  const basename = normalizeManifestBasename(params.invocationHead)
  const segment = params.requirements[0]?.provenance?.segment ?? params.invocationHead
  const baseAudit = (
    partial: Omit<EffectManifestAuditV1, 'commandBasename' | 'manifestFingerprint'> & {
      manifestFingerprint?: string
    },
  ): EffectManifestAuditV1 => ({
    frontendId: params.frontendId ?? 'legacy-v1',
    role: params.role === 'telemetry-only' ? 'candidate' : 'canonical',
    commandBasename: basename ?? params.decoderHead,
    manifestFingerprint: partial.manifestFingerprint ?? '',
    ...partial,
  })

  const gateConsumptionEnabled = params.gateConsumptionEnabled === true
  const observabilityOnly = params.role === 'telemetry-only'

  if (
    params.segmentCompleteness !== 'complete' ||
    !isGrammarUnknownOnly(params.requirements, params.decoderHead) ||
    requirementsBlockManifest(params.requirements)
  ) {
    return { requirements: params.requirements, telemetrySignals: [], matched: false }
  }

  if (!gateConsumptionEnabled && !observabilityOnly) {
    return { requirements: params.requirements, telemetrySignals: [], matched: false }
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
      matched: false,
    }
  }

  const loaded = loadEffectManifestSync(params.repoRoot, basename)
  if (!loaded.ok) {
    const unavailable = loaded.reason !== 'no_manifest'
    return {
      requirements: params.requirements,
      audit: baseAudit({
        manifestFingerprint: '',
        trust: unavailable ? 'invalid' : 'missing',
        outcome: unavailable ? 'unavailable' : 'unmatched',
        reason: loaded.reason,
      }),
      telemetrySignals: [],
      matched: false,
    }
  }
  const manifest = loaded.manifest

  if (manifest.command.basename !== basename) {
    return {
      requirements: params.requirements,
      audit: baseAudit({
        manifestFingerprint: manifestFingerprint(manifest),
        trust: 'invalid',
        outcome: 'unavailable',
        reason: 'basename_mismatch',
      }),
      telemetrySignals: [],
      matched: false,
    }
  }

  const identityStatus = verifyStoredExecutableIdentity(manifest.command)
  if (identityStatus !== 'ok') {
    return {
      requirements: params.requirements,
      audit: baseAudit({
        manifestFingerprint: manifestFingerprint(manifest),
        trust: 'invalid',
        outcome: 'unavailable',
        reason:
          identityStatus === 'missing'
            ? 'executable_missing'
            : identityStatus === 'not_regular'
              ? 'executable_not_regular'
              : 'executable_identity_mismatch',
      }),
      telemetrySignals: [],
      matched: false,
    }
  }

  if (
    !invocationMatchesManifestCommand(
      params.invocationHead,
      params.cwd,
      params.pathEnv,
      manifest.command,
    )
  ) {
    return {
      requirements: params.requirements,
      audit: baseAudit({
        manifestFingerprint: manifestFingerprint(manifest),
        trust: 'invalid',
        outcome: 'unavailable',
        reason: 'invocation_identity_mismatch',
      }),
      telemetrySignals: [],
      matched: false,
    }
  }

  const fingerprint = manifestFingerprint(manifest)
  const argv = params.argv.slice(1)
  const matchedRule = findUniqueMatchingRule(argv, manifest.rules)
  const trusted = matchedRule
    ? trustedRule(manifest, params.repoRoot, basename, params.trustRecord, belayConfig, matchedRule)
    : false
  if (!matchedRule || !trusted) {
    return {
      requirements: params.requirements,
      audit: baseAudit({
        manifestFingerprint: fingerprint,
        trust: resolveTrustAudit(
          manifest,
          params.repoRoot,
          basename,
          params.trustRecord,
          belayConfig,
          matchedRule ?? null,
        ),
        outcome: 'unmatched',
        reason: matchedRule ? 'rule_not_trusted' : 'no_rule_match',
        ...(matchedRule ? { ruleId: matchedRule.id } : {}),
      }),
      telemetrySignals: [],
      matched: false,
    }
  }

  const ruleFp = ruleFingerprint(manifest, matchedRule)
  const audit: EffectManifestAuditV1 = baseAudit({
    manifestFingerprint: fingerprint,
    ruleId: matchedRule.id,
    ruleFingerprint: ruleFp,
    trust: 'trusted',
    outcome: 'matched',
    reason: params.role === 'telemetry-only' ? 'shadow_candidate_match' : 'trusted_rule_match',
  })

  if (!gateConsumptionEnabled || params.role === 'telemetry-only') {
    return {
      requirements: params.requirements,
      audit,
      telemetrySignals: observabilityOnly ? ['effect_manifest.shadow_candidate_matched'] : [],
      matched: false,
    }
  }

  const instantiated = instantiateRequirements(matchedRule, params.decoderHead, segment)
  if (!instantiated) {
    return {
      requirements: params.requirements,
      audit: baseAudit({
        manifestFingerprint: fingerprint,
        ruleId: matchedRule.id,
        trust: 'trusted',
        outcome: 'unavailable',
        reason: 'contract_not_runtime_authoritative',
      }),
      telemetrySignals: [],
      matched: false,
    }
  }

  return {
    requirements: instantiated,
    audit,
    telemetrySignals: ['effect_manifest.matched'],
    matched: true,
  }
}
