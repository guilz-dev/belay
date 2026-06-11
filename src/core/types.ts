export type BelayMode = 'enforce' | 'audit'

export type HookVerdict = 'allow' | 'allow_flagged' | 'deny_pending_approval'

export type Reversibility = 'reversible' | 'recoverable_with_cost' | 'irreversible'

export interface Assessment {
  reversibility: Reversibility
  external: boolean
  blastRadius: string
  confidence: number
  signals: string[]
}

export interface ClassifyResult {
  verdict: HookVerdict
  reason: string
  fingerprint: string
  assessment: Assessment
  normalizedCommand?: string
  summary?: string
}

export type UnknownLocalEffectPolicy = 'allow_flagged' | 'deny'

export type UnparseableShellPolicy = 'allow_flagged' | 'deny'

export type ControlPlaneIntegrity = 'hash-pinned' | 'none'

export interface ScrubOptions {
  maskApprovalIds?: boolean
  maskBearerTokens?: boolean
  maskAuthHeaders?: boolean
  maskKeyValueSecrets?: boolean
  maskHighEntropyStrings?: boolean
}

export interface ConfidenceThresholds {
  allow: number
  flag: number
}

export interface ClassifierOptions {
  strictChains?: boolean
  customExternalCommands?: string[]
  customAllowCommands?: string[]
  sensitivePaths?: string[]
  unknownLocalEffect?: UnknownLocalEffectPolicy
  unparseableShell?: UnparseableShellPolicy
  controlPlaneDir?: string | null
  protectedArtifactRoots?: string[]
  confidenceThresholds?: ConfidenceThresholds
  scrubOptions?: ScrubOptions
  /** When true, L1 egress proxy is the external-effect boundary. */
  egressEnabled?: boolean
  /** When true with egress enabled, external command rules become early warnings only. */
  demoteL3External?: boolean
}

export interface ApprovalRecord {
  approvalId: string
  kind: 'shell' | 'subagent' | 'tool' | 'egress'
  fingerprint: string
  repoRoot: string
  reason: string
  summary: string
  createdAt: string
  expiresAt: string
  approvedAt?: string
}

export interface ApprovalStateFile {
  version: 1
  approvals: ApprovalRecord[]
}
