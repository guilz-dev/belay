import type { FsScopeAllowlistFile } from './capability/types.js'

export type BelayMode = 'enforce' | 'audit'

export type HookVerdict = 'allow' | 'allow_flagged' | 'deny_pending_approval' // concept: ask

export type Reversibility = 'reversible' | 'recoverable_with_cost' | 'irreversible'

export interface Assessment {
  reversibility: Reversibility
  external: boolean
  blastRadius: string
  confidence: number
  signals: string[]
}

export interface VerdictAxes {
  location: string
  opacity: string
  effect: string
  confidence: string
  would: string
  by: string
  commandRedacted?: string
  commandFingerprint?: string
  signals?: string[]
  judgeProvider?: 'openai-compatible' | 'ollama' | 'fallback'
  judgeModelRequested?: string
  judgeModelResolved?: string
  judgeLatencyMs?: number
  judgeOutboundRedacted?: boolean
  judgeFallbackReason?: string
}

export interface ClassifyResult {
  verdict: HookVerdict
  reason: string
  fingerprint: string
  assessment: Assessment
  normalizedCommand?: string
  summary?: string
  axes?: VerdictAxes
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
  /** When true with sandbox enabled, outside-repo rules defer to fs-scope allowlist. */
  brokerFsScope?: boolean
  fsScopeAllowlist?: FsScopeAllowlistFile
  /** Test override: inject Tier1 judge without changing config.judge. */
  tier1Judge?: import('./verdict/types.js').Tier1Judge
  /** When false, path resolution stays fail-closed (opaque cd chains). Default: Boolean(cwd). */
  trustedCwd?: boolean
}

export interface ApprovalRecord {
  approvalId: string
  kind: 'shell' | 'subagent' | 'tool' | 'egress' | 'capability'
  fingerprint: string
  repoRoot: string
  reason: string
  summary: string
  createdAt: string
  expiresAt: string
  approvedAt?: string
  /** Short-lived lease so duplicate hook invocations for one retry can share approval. */
  executionLeaseExpiresAt?: string
  /** Original gated input for explain-last-ask (ApprovalState v2). */
  input?: string
  inputKind?: 'shell' | 'tool' | 'subagent'
}

export interface ApprovalStateFile {
  version: 1 | 2
  approvals: ApprovalRecord[]
}
