export type EffectManifestFallbackV1 = 'indeterminate'

export type ArgvMatcherV1 =
  | { kind: 'literal'; value: string }
  | { kind: 'enum'; name: string; values: string[] }
  | { kind: 'path'; name: string }
  | { kind: 'host'; name: string }
  | { kind: 'integer'; name: string; min?: number; max?: number }
  | { kind: 'token'; name: string }

export interface ManifestEffectTemplateV1 {
  tag: string
  action: string
  resource: Record<string, unknown>
}

export interface EffectManifestRuleV1 {
  id: string
  matcher: { argv: ArgvMatcherV1[] }
  contract: {
    processOperation: 'inspect' | 'spawn' | 'signal'
    effects: ManifestEffectTemplateV1[]
  }
  assertion: 'complete-upper-bound'
  inference: {
    method: 'static' | 'llm-assisted' | 'manual'
    generatedAt: string
    generatorVersion: string
    model?: string
    evidence: unknown[]
    warnings: string[]
  }
}

export interface EffectManifestV1 {
  schemaVersion: 1
  command: {
    basename: string
    canonicalPath: string
    sha256: string
    kind: 'native' | 'script'
    interpreter?: { canonicalPath: string; sha256: string }
  }
  fallback: EffectManifestFallbackV1
  rules: EffectManifestRuleV1[]
}

export interface EffectManifestTrustRecordV1 {
  schemaVersion: 1
  repoRoot: string
  manifestPath: string
  commandIdentityFingerprint: string
  trustedRules: Array<{
    id: string
    ruleFingerprint: string
    trustedAt: string
  }>
}

export type EffectManifestApplicationRole = 'canonical' | 'telemetry-only'

export type EffectManifestFrontendId = 'legacy-v1' | 'mvdan-v1'

export interface EffectManifestAuditV1 {
  frontendId?: EffectManifestFrontendId
  role?: 'canonical' | 'candidate'
  commandBasename: string
  manifestFingerprint: string
  ruleId?: string
  ruleFingerprint?: string
  trust: 'trusted' | 'missing' | 'stale' | 'invalid'
  outcome: 'matched' | 'unmatched' | 'unavailable'
  reason: string
}
