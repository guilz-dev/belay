import path from 'node:path'

import type { ProcessOperation } from '../capability/request.js'
import { type BelayConfigV3, mergeConfig } from '../config.js'
import type { ShellEffectRequirement } from '../effect-ir/shell-build.js'
import { isGrammarUnknownOnly } from '../effect-ir/shell-lower/argv-delegate-gate.js'
import { processRequirement } from '../effect-ir/shell-lower/requirement.js'
import { canonicalPath } from '../path-utils.js'
import { manifestFingerprint, ruleFingerprint } from './codec.js'
import { commandIdentityFingerprint } from './command-identity.js'
import { instantiateManifestEffectTemplate } from './effect-template.js'
import { verifyStoredExecutableIdentity } from './executable-identity.js'
import { invocationMatchesManifestCommand } from './invocation-identity.js'
import { loadEffectManifestSync } from './load-manifest-sync.js'
import { loadEffectManifestTrustSync } from './load-trust-sync.js'
import { findUniqueMatchingRule, type ManifestCaptures } from './matcher.js'
import { manifestFilePath, normalizeManifestBasename } from './paths.js'
import type {
  EffectManifestApplicationRole,
  EffectManifestAuditV1,
  EffectManifestTrustRecordV1,
  EffectManifestV1,
} from './types.js'
import { manifestAuthorityIssues, ruleIsTrustEligible } from './validate.js'

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
  belayConfig?: BelayConfigV3
  /** Wall-clock deadline; manifest work is skipped after this instant (fail-closed). */
  effectManifestAnalysisDeadlineMs?: number
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
  captures: ManifestCaptures,
  head: string,
  segment: string,
  cwd: string,
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
    const instantiated = instantiateManifestEffectTemplate(template, captures, cwd)
    if (!instantiated.ok) {
      return null
    }
    effects.push({
      tag: template.tag as ShellEffectRequirement['tag'],
      action: template.action as ShellEffectRequirement['action'],
      resource: instantiated.resource as ShellEffectRequirement['resource'],
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

function ruleTrustStatus(
  manifest: EffectManifestV1,
  repoRoot: string,
  basename: string,
  trustRecord: EffectManifestTrustRecordV1 | null,
  belayConfig: BelayConfigV3,
  rule: EffectManifestV1['rules'][number] | null,
): EffectManifestAuditV1['trust'] {
  if (!rule) {
    return 'missing'
  }
  const record =
    trustRecord ??
    loadEffectManifestTrustSync(repoRoot, manifest.command.canonicalPath, belayConfig)
  if (!record) {
    return 'missing'
  }
  if (record.repoRoot !== repoRoot) {
    return 'invalid'
  }
  const expectedManifestPath = manifestFilePath(repoRoot, basename)
  if (path.resolve(record.manifestPath) !== path.resolve(expectedManifestPath)) {
    return 'invalid'
  }
  if (record.commandIdentityFingerprint !== commandIdentityFingerprint(manifest.command)) {
    return 'stale'
  }
  const fingerprint = ruleFingerprint(manifest, rule)
  const entry = record.trustedRules.find((item) => item.id === rule.id)
  if (!entry) {
    return 'missing'
  }
  return entry.ruleFingerprint !== fingerprint ? 'stale' : 'trusted'
}

export function applyEffectManifest(params: ApplyEffectManifestParams): ApplyEffectManifestResult {
  const belayConfig = params.belayConfig ?? mergeConfig({})
  const repoRoot = canonicalPath(params.repoRoot)
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

  const observabilityOnly = params.role === 'telemetry-only'

  const deadlineExceeded = (): boolean =>
    params.effectManifestAnalysisDeadlineMs !== undefined &&
    Date.now() >= params.effectManifestAnalysisDeadlineMs

  const deadlineResult = (): ApplyEffectManifestResult => ({
    requirements: params.requirements,
    audit: baseAudit({
      trust: 'invalid',
      outcome: 'unavailable',
      reason: 'deadline_exceeded',
    }),
    telemetrySignals: [],
    matched: false,
  })

  if (
    params.segmentCompleteness !== 'complete' ||
    !isGrammarUnknownOnly(params.requirements, params.decoderHead) ||
    requirementsBlockManifest(params.requirements)
  ) {
    return { requirements: params.requirements, telemetrySignals: [], matched: false }
  }

  if (deadlineExceeded()) {
    return deadlineResult()
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

  const loaded = loadEffectManifestSync(repoRoot, basename)
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

  if (deadlineExceeded()) {
    return deadlineResult()
  }

  if (manifestAuthorityIssues(manifest).length > 0) {
    return {
      requirements: params.requirements,
      audit: baseAudit({
        manifestFingerprint: manifestFingerprint(manifest),
        trust: 'invalid',
        outcome: 'unavailable',
        reason: 'manifest_invalid',
      }),
      telemetrySignals: [],
      matched: false,
    }
  }

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
  if (deadlineExceeded()) {
    return deadlineResult()
  }
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
              : identityStatus === 'not_executable'
                ? 'executable_not_executable'
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

  if (deadlineExceeded()) {
    return deadlineResult()
  }

  const fingerprint = manifestFingerprint(manifest)
  const argv = params.argv.slice(1)
  const matched = findUniqueMatchingRule(argv, manifest.rules)
  const trust = ruleTrustStatus(
    manifest,
    repoRoot,
    basename,
    params.trustRecord,
    belayConfig,
    matched?.rule ?? null,
  )
  if (deadlineExceeded()) {
    return deadlineResult()
  }
  if (!matched || trust !== 'trusted') {
    const unmatchedRule = matched?.rule ?? null
    return {
      requirements: params.requirements,
      audit: baseAudit({
        manifestFingerprint: fingerprint,
        trust,
        outcome: 'unmatched',
        reason: unmatchedRule ? 'rule_not_trusted' : 'no_rule_match',
        ...(unmatchedRule ? { ruleId: unmatchedRule.id } : {}),
      }),
      telemetrySignals: [],
      matched: false,
    }
  }

  const matchedRule = matched.rule

  const ruleFp = ruleFingerprint(manifest, matchedRule)
  const audit: EffectManifestAuditV1 = baseAudit({
    manifestFingerprint: fingerprint,
    ruleId: matchedRule.id,
    ruleFingerprint: ruleFp,
    trust: 'trusted',
    outcome: 'matched',
    reason: params.role === 'telemetry-only' ? 'shadow_candidate_match' : 'trusted_rule_match',
  })

  if (params.role === 'telemetry-only') {
    return {
      requirements: params.requirements,
      audit,
      telemetrySignals: observabilityOnly ? ['effect_manifest.shadow_candidate_matched'] : [],
      matched: false,
    }
  }

  const instantiated = instantiateRequirements(
    matchedRule,
    matched.captures,
    params.decoderHead,
    segment,
    params.cwd,
  )
  if (deadlineExceeded()) {
    return deadlineResult()
  }
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
