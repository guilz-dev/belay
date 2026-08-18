import type { BoundaryAttestation } from './capability/attestation.js'
import type { CapabilityGrantV1 } from './capability/grant.js'
import type { PolicyDecision } from './capability/policy-types.js'
import type { CapabilityRequestV1 } from './capability/request.js'
import type { FsScopeAllowlistFile } from './capability/types.js'
import type { EffectPlan, EffectPlanPolicyProjection } from './effect-ir/types.js'

export interface MediatedExecutionResult {
  exitCode: number | null
  signal: string | null
  timedOut: boolean
  stdout: string
  stderr: string
  stdoutTruncated: boolean
  stderrTruncated: boolean
  receiptHash: string
}

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
  capabilityRequests?: CapabilityRequestV1[]
  authorizationDecision?: PolicyDecision
  effectPlan?: EffectPlan
  effectPlanPolicyDecisions?: PolicyDecision[]
  effectPlanProjection?: EffectPlanPolicyProjection
  boundaryProfile?: string
  wouldMediate?: boolean
  mediatedExecution?: MediatedExecutionResult
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
  /** @deprecated Accepted for API compatibility but ignored by shell EffectPlan authorization. */
  customExternalCommands?: string[]
  /** @deprecated Accepted for API compatibility but ignored by shell EffectPlan authorization. */
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
  trustedWorkspaceRoots?: string[]
  /** When false, path resolution stays fail-closed (opaque cd chains). Default: Boolean(cwd). */
  trustedCwd?: boolean
  grants?: CapabilityGrantV1[]
  attestation?: BoundaryAttestation | null
  boundaryProfile?: string
  /** True when egress proxy is running and bound to this repository. */
  egressProxyActive?: boolean
}

export interface ApprovalScopeHint {
  scope: 'workspace-root'
  path: string
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
  /** Replay envelope: working directory when the action was gated. */
  cwd?: string
  /** Replay envelope: tool name for tool/subagent actions. */
  toolName?: string
  /** Replay envelope: canonical payload hash for strict replay validation. */
  payloadHash?: string
  /** Replay envelope: scrubbed payload JSON for explain (size-capped at write time). */
  payloadJson?: string
  /** Optional scope hint for structured capability approvals. */
  scopeHint?: ApprovalScopeHint
  /** Approval state v3: normalized capability requests at ask time. */
  capabilityRequests?: CapabilityRequestV1[]
  /** Approval state v3: hash of capabilityRequests for replay binding. */
  capabilityRequestHash?: string
  /** Approval state v3: hash of normalized EffectPlan for composite replay binding. */
  effectPlanHash?: string
  /** Approval state v3: minted grant after human approval (legacy single grant; first of bundle). */
  grant?: CapabilityGrantV1
  /** Approval state v3: all grants for composite capability requests (atomic bundle). */
  grants?: CapabilityGrantV1[]
  /** Exact one-to-one grant bundle contract. Missing means legacy fingerprint authorization. */
  grantBundleVersion?: 1
}

export interface ApprovalStateFile {
  version: 1 | 2 | 3
  /** Optimistic concurrency revision (v3). */
  revision?: number
  approvals: ApprovalRecord[]
}
