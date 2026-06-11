import type { Assessment, ConfidenceThresholds, HookVerdict } from '../types.js'

export type PolicyAction = 'allow' | 'flag' | 'deny' | 'escalate' | 'threshold'

export type BlastRadiusScope = 'none' | 'file' | 'dir' | 'repo' | 'outside' | 'external'

export interface ShellAttributes {
  commandKey: string
  normalizedCommand: string
  cwdRelative: string
  flags: string[]
  targetScope: BlastRadiusScope
  redirectKind: 'none' | 'append' | 'truncate' | 'outside' | 'protected'
  signals: string[]
  isUnparseable: boolean
  isDynamicEval: boolean
  hasPipeToShell: boolean
  hitsProtectedArtifact: boolean
  hitsOutsideRepo: boolean
  isCustomAllow: boolean
  isCustomExternal: boolean
  isReadOnlyKey: boolean
  isFlaggedKey: boolean
  isExternalKey: boolean
  hasCredentialHeader: boolean
  findDangerous: boolean
}

export interface PolicyMatch {
  signal?: string
  commandKey?: string | string[]
  targetScope?: BlastRadiusScope | BlastRadiusScope[]
  redirectKind?: ShellAttributes['redirectKind'] | ShellAttributes['redirectKind'][]
  flag?: string | string[]
  customAllow?: boolean
  customExternal?: boolean
  unparseable?: boolean
  protectedArtifact?: boolean
  outsideRepo?: boolean
}

export interface PolicyRule {
  id: string
  priority: number
  nonOverridable?: boolean
  match: PolicyMatch
  action: PolicyAction
  reason: string
  assessment?: Partial<Assessment>
}

export interface PolicyEvaluationContext {
  attributes: ShellAttributes
  assessment: Assessment
  unknownLocalEffect: 'allow_flagged' | 'deny'
  unparseableShell: 'allow_flagged' | 'deny'
  confidenceThresholds: ConfidenceThresholds
}

export interface PolicyEvaluationResult {
  verdict: HookVerdict
  reason: string
  assessment: Assessment
  matchedRuleId: string
}
