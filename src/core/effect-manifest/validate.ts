import { parseEffectManifestV1 } from './codec.js'
import { captureReferencesInTemplate, validateManifestEffectTemplate } from './effect-template.js'
import { verifyStoredExecutableIdentity } from './executable-identity.js'
import { matcherLanguagesOverlap } from './matcher.js'
import type { EffectManifestRuleV1, EffectManifestV1 } from './types.js'

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

function validateCaptureContract(rule: EffectManifestRuleV1): ManifestValidationIssue[] {
  const issues: ManifestValidationIssue[] = []
  const captures = new Map(
    rule.matcher.argv.flatMap((entry) => (entry.kind === 'literal' ? [] : [[entry.name, entry]])),
  )
  const references = new Set<string>()
  for (const effect of rule.contract.effects) {
    for (const reference of captureReferencesInTemplate(effect)) {
      references.add(reference)
    }
  }
  const expectedCaptureKinds: Record<string, ReadonlySet<string>> = {
    path: new Set(['path']),
    repoPath: new Set(['path']),
    host: new Set(['host']),
    port: new Set(['integer']),
    ref: new Set(['token', 'enum']),
  }
  for (const effect of rule.contract.effects) {
    for (const [field, value] of Object.entries(effect.resource)) {
      if (typeof value !== 'string') {
        continue
      }
      for (const match of value.matchAll(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g)) {
        const name = match[1]
        const capture = name ? captures.get(name) : undefined
        const expected = expectedCaptureKinds[field]
        const staticallyRequired =
          effect.action === 'process.exec' || effect.action === 'control_plane.write'
        if (staticallyRequired || !capture || !expected?.has(capture.kind)) {
          issues.push({
            code: 'capture_type_mismatch',
            message: `Rule ${rule.id}: capture ${name ?? ''} is not valid for resource field ${field}.`,
            ruleId: rule.id,
          })
        }
        if (field === 'port' && value !== `\${${name}}`) {
          issues.push({
            code: 'capture_type_mismatch',
            message: `Rule ${rule.id}: integer capture ${name ?? ''} must occupy the complete port field.`,
            ruleId: rule.id,
          })
        }
      }
    }
  }
  for (const name of captures.keys()) {
    if (!references.has(name)) {
      issues.push({
        code: 'unused_capture',
        message: `Rule ${rule.id}: capture ${name} is not used by an effect resource.`,
        ruleId: rule.id,
      })
    }
  }
  for (const name of references) {
    if (!captures.has(name)) {
      issues.push({
        code: 'unknown_capture',
        message: `Rule ${rule.id}: effect resource references unknown capture ${name}.`,
        ruleId: rule.id,
      })
    }
  }
  rule.matcher.argv.forEach((entry, index) => {
    if (
      entry.kind === 'token' &&
      (index === 0 || !rule.matcher.argv.slice(0, index).some((prior) => prior.kind === 'literal'))
    ) {
      issues.push({
        code: 'broad_token_capture',
        message: `Rule ${rule.id}: token capture ${entry.name} must follow a literal matcher.`,
        ruleId: rule.id,
      })
    }
  })
  return issues
}

function validateEffectTemplates(rule: EffectManifestRuleV1): ManifestValidationIssue[] {
  const issues: ManifestValidationIssue[] = []
  for (const effect of rule.contract.effects) {
    const validated = validateManifestEffectTemplate(effect)
    if (!validated.ok) {
      issues.push({
        code: 'invalid_effect_template',
        message: `Rule ${rule.id}: ${validated.message}`,
        ruleId: rule.id,
      })
    }
  }
  return issues
}

export function ruleValidationIssues(rule: EffectManifestRuleV1): ManifestValidationIssue[] {
  return [...validateEffectTemplates(rule), ...validateCaptureContract(rule)]
}

export function ruleIsTrustEligible(rule: EffectManifestRuleV1): boolean {
  return (
    !rule.contract.effects.some((effect) => effect.tag === 'indeterminate') &&
    ruleValidationIssues(rule).length === 0
  )
}

export function manifestAuthorityIssues(manifest: EffectManifestV1): ManifestValidationIssue[] {
  const issues = manifest.rules.flatMap(ruleValidationIssues)
  for (let leftIndex = 0; leftIndex < manifest.rules.length; leftIndex += 1) {
    const left = manifest.rules[leftIndex]
    if (!left) {
      continue
    }
    for (let rightIndex = leftIndex + 1; rightIndex < manifest.rules.length; rightIndex += 1) {
      const right = manifest.rules[rightIndex]
      if (right && matcherLanguagesOverlap(left.matcher.argv, right.matcher.argv)) {
        issues.push({
          code: 'matcher_overlap',
          message: `Rules ${left.id} and ${right.id} have overlapping matchers.`,
          ruleId: right.id,
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
  const authorityIssues = manifestAuthorityIssues(manifest)
  const issues = [...authorityIssues]
  const identity = verifyStoredExecutableIdentity(manifest.command)
  if (identity !== 'ok') {
    issues.push({
      code: 'executable_identity',
      message:
        identity === 'missing'
          ? 'Executable is missing on disk.'
          : identity === 'not_regular'
            ? 'Executable is not a regular executable file.'
            : identity === 'not_executable'
              ? 'Executable or script interpreter is not executable.'
              : 'Executable identity is stale and no longer matches the manifest.',
    })
  }
  const trustEligibleRuleIds =
    authorityIssues.length === 0
      ? manifest.rules.filter(ruleIsTrustEligible).map((rule) => rule.id)
      : []
  return {
    ok: issues.length === 0,
    manifest,
    issues,
    trustEligibleRuleIds,
  }
}
