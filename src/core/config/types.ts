import type { BoundaryDriverId } from '../capability/attestation.js'
import type {
  BelayMode,
  ControlPlaneIntegrity,
  UnknownLocalEffectPolicy,
  UnparseableShellPolicy,
} from '../types.js'
import type { BelayJudgeRuntimeConfig } from '../verdict/judge-runtime-config.js'

/** Compatibility shape for the current-main audit sink/reader adapters. */
export interface AuditRetentionConfig {
  maxBytes: number
  maxFiles: number
}

export interface BelayAuditConfig {
  logPath: string
  includeAssessment: boolean
  /** Optional in source config for backwards compatibility; normalization always supplies it. */
  maxBytes?: number
  /** Optional in source config for backwards compatibility; active counts as one retained file. */
  maxFiles?: number
  /** Legacy current-main spelling; canonical normalized config uses maxBytes/maxFiles directly. */
  retention?: Partial<AuditRetentionConfig>
}

export interface NormalizedBelayAuditConfig extends BelayAuditConfig {
  maxBytes: number
  maxFiles: number
  /** Preserved only when the loaded source used the legacy nested spelling. */
  retention?: AuditRetentionConfig
}

export interface BelayConfigV1 {
  version: 1
  mode: BelayMode
  approvalTtlMinutes: number
  tokenPrefix: string
  gates: {
    shell: boolean
    subagent: boolean
  }
  audit: Pick<BelayAuditConfig, 'logPath'>
}

export interface BelayConfigV2 {
  version: 2
  mode: BelayMode
  approvalTtlMinutes: number
  tokenPrefix: string
  gates: {
    shell: boolean
    subagent: boolean
    fileMutation: boolean
    toolShell: boolean
  }
  classifier: {
    strictChains: boolean
    customExternalCommands: string[]
    customAllowCommands: string[]
    sensitivePaths: string[]
  }
  audit: BelayAuditConfig
}

export interface BelayConfidenceThresholds {
  allow: number
  flag: number
}

export interface BelayModelAssistConfig {
  enabled: boolean
  model?: string
  timeoutMs?: number
}

export interface BelayFileCheckpointConfig {
  enabled: boolean
  allowNonGit: boolean
  maxFiles: number
  maxSourceBytes: number
  maxWorkspaceBytes: number
  prepareTimeoutMs: number
  copyConcurrency: number
}

export interface BelayTransactionalConfig {
  enabled: boolean
  minConfidence: number
  maxConfidence: number
  timeoutMs: number
  maxDeletionCount: number
  gates: {
    shell: boolean
  }
  fileCheckpoint: BelayFileCheckpointConfig
  checkpoint?: {
    enabled: boolean
    appliedRetentionHours: number
    restoredRetentionHours: number
    maxCheckpoints: number
    maxBytes: number
  }
}

export interface BelayPolicyConfig {
  unknownLocalEffect: UnknownLocalEffectPolicy
  unparseableShell: UnparseableShellPolicy
  confidenceThresholds: BelayConfidenceThresholds
  modelAssist: BelayModelAssistConfig
  transactional: BelayTransactionalConfig
  // Adapter compatibility name: how to treat a tool whose name belay does not yet map to a known
  // kind. 'deny' (default) is the fail-closed floor — an unmapped tool must not
  // silently bypass the gate (FN=0). 'allow' is the opt-out: pass the tool but record it to the
  // audit log for vocabulary learning (use only if fail-closed over-blocks in practice). See
  // unknownLocalEffect. Optional; runtime defaults to 'deny' when absent.
  codexUnmappedTool?: 'allow' | 'deny'
  /** R-V2: silent-pass rate below this triggers fence-drift warning (default 0.5). */
  fenceWarnThreshold: number
}

export interface BelayOverridesConfig {
  allow: string[]
  external: string[]
}

export interface BelayRedactionConfig {
  maskApprovalIds: boolean
  maskBearerTokens: boolean
  maskAuthHeaders: boolean
  maskKeyValueSecrets: boolean
  maskHighEntropyStrings: boolean
}

export type JudgeProvider = 'ollama' | 'openai-compatible' | 'anthropic'

export type JudgeProviderId = 'ollama' | 'codex' | 'claude' | 'cursor'

/** Read-only legacy ids; preserved on load with warning until `belay config` migrates. */
export type DeprecatedJudgeProviderId = 'openrouter' | 'custom'

export type JudgeCredentialMode = 'project' | 'apiKey'

export type JudgeCredentialRef = `store:judge` | `env:${string}`

export interface JudgeCredentialConfig {
  mode: JudgeCredentialMode
  ref?: JudgeCredentialRef
}

export interface JudgeCloudConsent {
  accepted: boolean
  at: string
  providerId: JudgeProviderId
  endpoint: string
  by: string
}

export type BelayJudgeMode = 'shadow' | 'off'

export interface BelayJudgeConfig {
  /** Gate uses PolicyEngine; judge runs async shadow/compare only. */
  mode?: BelayJudgeMode
  provider: JudgeProvider
  providerId?: JudgeProviderId | DeprecatedJudgeProviderId
  model: string
  timeoutMs: number
  endpoint: string | null
  keepAlive: string | null
  cloudConsent?: JudgeCloudConsent
  credential?: JudgeCredentialConfig
  runtime?: BelayJudgeRuntimeConfig
}

export type ControlPlaneIsolationMode = 'none' | 'read-only-mount' | 'separate-user'

export interface BelayControlPlaneIsolationConfig {
  mode: ControlPlaneIsolationMode
  expectedOwnerUid?: number
  verifyAgentWritable: boolean
}

export interface BelayControlPlaneConfig {
  enabled: boolean
  configDir: string | null
  integrity: ControlPlaneIntegrity
  isolation: BelayControlPlaneIsolationConfig
}

export type SandboxRuntime = 'none' | 'cursor-sandbox' | 'container' | 'seatbelt' | 'landlock'

export interface BelaySandboxConfig {
  enabled: boolean
  runtime: SandboxRuntime
  denyNetworkByDefault: boolean
  /** Optional in source config for backwards compatibility; normalization always supplies it. */
  containedExecution?: BelayContainedExecutionConfig
}

export interface BelayContainedExecutionConfig {
  enabled: boolean
  image: string | null
  /** Required when enabled; optional in source objects for disabled backwards compatibility. */
  dockerExecutable?: string | null
  /** Required when enabled; only local absolute unix:// endpoints are accepted. */
  dockerHost?: string | null
  timeoutMs: number
  memoryMiB: number
  cpus: number
  pids: number
}

export interface BelayClassifierConfig {
  strictChains: boolean
  sensitivePaths: string[]
}

export interface BelayNotificationsConfig {
  webhookUrl?: string
  commandHook?: string
}

export interface BelayApprovalSigningConfig {
  /** When true, out-of-band approvals must present a signed token. */
  required: boolean
}

export type ApprovalFlow = 'one_step' | 'two_step'

export interface BelayApprovalAutoReplayScopes {
  shell: boolean
  tool: boolean
  subagent: boolean
}

export interface BelayApprovalConfig {
  flow: ApprovalFlow
  autoReplayScopes: BelayApprovalAutoReplayScopes
  executionLeaseMs: number
}

export interface BelayEgressConfig {
  enabled: boolean
  listenHost: string
  listenPort: number
  /** When true with egress enabled, L3 external command lists become hints only. */
  demoteL3External: boolean
}

export interface BelayCapabilityConfig {
  grantsEnabled?: boolean
  boundaryDriver?: BoundaryDriverId
  attestationRelPath?: string
}

export interface BelayConfigV4 {
  version: 4 | 5
  adapter?: 'cursor' | 'claude' | 'codex'
  /** Where hooks/runtime/skill artifacts are installed. Defaults to project. */
  installScope?: 'project' | 'global'
  mode: BelayMode
  approvalTtlMinutes: number
  tokenPrefix: string
  gates: BelayConfigV2['gates']
  classifier: BelayClassifierConfig
  policy: BelayPolicyConfig
  overrides: BelayOverridesConfig
  redaction: BelayRedactionConfig
  controlPlane: BelayControlPlaneConfig
  notifications: BelayNotificationsConfig
  approvalSigning: BelayApprovalSigningConfig
  approval: BelayApprovalConfig
  egress: BelayEgressConfig
  sandbox: BelaySandboxConfig
  audit: BelayConfigV2['audit']
  judge: BelayJudgeConfig
  capability?: BelayCapabilityConfig
}

/** @deprecated Use BelayConfigV4 */
export type BelayConfigV3 = BelayConfigV4

export type BelayConfig = BelayConfigV4

export type RawConfigInput = Partial<{
  version: number
  judge: Partial<BelayJudgeConfig>
  mode: BelayMode
  approvalTtlMinutes: number
  tokenPrefix: string
  gates: Partial<BelayConfigV2['gates']>
  classifier: Partial<BelayConfigV2['classifier']> & Partial<BelayClassifierConfig>
  policy: Partial<BelayPolicyConfig>
  overrides: Partial<BelayOverridesConfig>
  redaction: Partial<BelayRedactionConfig>
  controlPlane: Partial<BelayControlPlaneConfig>
  notifications: Partial<BelayNotificationsConfig>
  approvalSigning: Partial<BelayApprovalSigningConfig>
  approval: Partial<BelayApprovalConfig> & {
    autoReplayScopes?: Partial<BelayApprovalAutoReplayScopes>
  }
  egress: Partial<BelayEgressConfig>
  sandbox: Partial<BelaySandboxConfig>
  audit: Partial<BelayConfigV2['audit']>
  installScope: 'project' | 'global'
  capability: Partial<BelayCapabilityConfig>
}>
