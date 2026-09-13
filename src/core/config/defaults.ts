import { DEFAULT_SILENT_PASS_THRESHOLD } from '../audit-summary.js'
import { DEFAULT_AUDIT_MAX_BYTES, DEFAULT_AUDIT_MAX_FILES } from './audit.js'
import type {
  BelayApprovalConfig,
  BelayApprovalSigningConfig,
  BelayCapabilityConfig,
  BelayConfidenceThresholds,
  BelayConfigV2,
  BelayConfigV4,
  BelayContainedExecutionConfig,
  BelayControlPlaneConfig,
  BelayControlPlaneIsolationConfig,
  BelayEgressConfig,
  BelayFileCheckpointConfig,
  BelayJudgeConfig,
  BelayModelAssistConfig,
  BelayNotificationsConfig,
  BelayOverridesConfig,
  BelayPolicyConfig,
  BelayRedactionConfig,
  BelaySandboxConfig,
  BelayTransactionalConfig,
} from './types.js'

export const DEFAULT_JUDGE_LOCAL_OLLAMA: BelayJudgeConfig = {
  mode: 'shadow',
  provider: 'ollama',
  providerId: 'ollama',
  model: 'gemma4:e2b',
  endpoint: 'http://localhost:11434',
  timeoutMs: 25000,
  keepAlive: '30m',
}

export const DEFAULT_JUDGE_OPENAI_COMPATIBLE_TEMPLATE: BelayJudgeConfig = {
  mode: 'shadow',
  provider: 'openai-compatible',
  providerId: 'codex',
  model: 'gpt-5.3-codex-high',
  timeoutMs: 8000,
  endpoint: null,
  keepAlive: null,
}

/** @deprecated Use DEFAULT_JUDGE_OPENAI_COMPATIBLE_TEMPLATE */
export const DEFAULT_JUDGE_CURSOR_COMPOSER = DEFAULT_JUDGE_OPENAI_COMPATIBLE_TEMPLATE

export const DEFAULT_CAPABILITY_V5: BelayCapabilityConfig = {
  grantsEnabled: true,
  boundaryDriver: 'host-integration',
  attestationRelPath: '.belay/attestation.json',
}

/** @deprecated Use DEFAULT_SILENT_PASS_THRESHOLD from audit-summary.js */
export const DEFAULT_FENCE_WARN_THRESHOLD = DEFAULT_SILENT_PASS_THRESHOLD

export const DEFAULT_CONFIDENCE_THRESHOLDS: BelayConfidenceThresholds = {
  allow: 0.88,
  flag: 0.72,
}

export const DEFAULT_MODEL_ASSIST: BelayModelAssistConfig = {
  enabled: false,
  timeoutMs: 3000,
}

export const DEFAULT_FILE_CHECKPOINT: BelayFileCheckpointConfig = {
  enabled: false,
  allowNonGit: false,
  maxFiles: 100_000,
  maxSourceBytes: 2_147_483_648,
  maxWorkspaceBytes: 4_294_967_296,
  prepareTimeoutMs: 30_000,
  copyConcurrency: 8,
}

export const DEFAULT_RECOVERY_CHECKPOINT: NonNullable<BelayTransactionalConfig['checkpoint']> = {
  enabled: false,
  appliedRetentionHours: 7 * 24,
  restoredRetentionHours: 24,
  maxCheckpoints: 20,
  maxBytes: 1024 * 1024 * 1024,
}

export const DEFAULT_TRANSACTIONAL_V3: BelayTransactionalConfig = {
  enabled: false,
  minConfidence: DEFAULT_CONFIDENCE_THRESHOLDS.flag,
  maxConfidence: DEFAULT_CONFIDENCE_THRESHOLDS.allow,
  timeoutMs: 30_000,
  maxDeletionCount: 10,
  gates: {
    shell: true,
  },
  fileCheckpoint: { ...DEFAULT_FILE_CHECKPOINT },
  checkpoint: { ...DEFAULT_RECOVERY_CHECKPOINT },
}

export const LEGACY_POLICY_V3: BelayPolicyConfig = {
  unknownLocalEffect: 'allow_flagged',
  unparseableShell: 'allow_flagged',
  confidenceThresholds: { ...DEFAULT_CONFIDENCE_THRESHOLDS },
  modelAssist: { ...DEFAULT_MODEL_ASSIST },
  transactional: { ...DEFAULT_TRANSACTIONAL_V3 },
  fenceWarnThreshold: DEFAULT_FENCE_WARN_THRESHOLD,
}

/** Fresh install defaults: recoverable-first with opaque/unparseable fail-closed. */
export const DEFAULT_POLICY_V3: BelayPolicyConfig = {
  unknownLocalEffect: 'allow_flagged',
  unparseableShell: 'deny',
  codexUnmappedTool: 'allow',
  confidenceThresholds: { ...DEFAULT_CONFIDENCE_THRESHOLDS },
  modelAssist: { ...DEFAULT_MODEL_ASSIST },
  transactional: { ...DEFAULT_TRANSACTIONAL_V3 },
  fenceWarnThreshold: DEFAULT_FENCE_WARN_THRESHOLD,
}

export const DEFAULT_OVERRIDES_V3: BelayOverridesConfig = {
  allow: [],
  external: [],
}

export const DEFAULT_REDACTION_V3: BelayRedactionConfig = {
  maskApprovalIds: true,
  maskBearerTokens: true,
  maskAuthHeaders: true,
  maskKeyValueSecrets: true,
  maskHighEntropyStrings: true,
}

export const DEFAULT_CONTROL_PLANE_ISOLATION_V3: BelayControlPlaneIsolationConfig = {
  mode: 'none',
  verifyAgentWritable: true,
}

export const LEGACY_CONTROL_PLANE_V3: BelayControlPlaneConfig = {
  enabled: false,
  configDir: null,
  integrity: 'none',
  isolation: { ...DEFAULT_CONTROL_PLANE_ISOLATION_V3 },
}

export const DEFAULT_CONTROL_PLANE_V3: BelayControlPlaneConfig = {
  enabled: true,
  configDir: null,
  integrity: 'hash-pinned',
  isolation: { ...DEFAULT_CONTROL_PLANE_ISOLATION_V3 },
}

export const DEFAULT_CONTAINED_EXECUTION: BelayContainedExecutionConfig = {
  enabled: false,
  image: null,
  dockerExecutable: null,
  dockerHost: null,
  timeoutMs: 30_000,
  memoryMiB: 2048,
  cpus: 2,
  pids: 256,
}

export const DEFAULT_SANDBOX_V3: BelaySandboxConfig = {
  enabled: false,
  runtime: 'none',
  denyNetworkByDefault: true,
  containedExecution: { ...DEFAULT_CONTAINED_EXECUTION },
}

export const DEFAULT_NOTIFICATIONS_V3: BelayNotificationsConfig = {}

export const DEFAULT_APPROVAL_SIGNING_V3: BelayApprovalSigningConfig = {
  required: false,
}

export const DEFAULT_APPROVAL_CONFIG: BelayApprovalConfig = {
  flow: 'one_step',
  autoReplayScopes: {
    shell: true,
    tool: false,
    subagent: false,
  },
  executionLeaseMs: 60_000,
}

export const DEFAULT_EGRESS_V3: BelayEgressConfig = {
  enabled: false,
  listenHost: '127.0.0.1',
  listenPort: 17831,
  demoteL3External: true,
}

export const DEFAULT_CONFIG_V2: BelayConfigV2 = {
  version: 2,
  mode: 'enforce',
  approvalTtlMinutes: 15,
  tokenPrefix: '/belay-approve',
  gates: {
    shell: true,
    subagent: true,
    fileMutation: true,
    toolShell: true,
  },
  classifier: {
    strictChains: true,
    customExternalCommands: [],
    customAllowCommands: [],
    sensitivePaths: ['.env', '.env.*', '**/credentials/**'],
  },
  audit: {
    logPath: 'belay/audit.ndjson',
    includeAssessment: true,
    maxBytes: DEFAULT_AUDIT_MAX_BYTES,
    maxFiles: DEFAULT_AUDIT_MAX_FILES,
  },
}

export const DEFAULT_CONFIG_V4: BelayConfigV4 = {
  version: 4,
  mode: DEFAULT_CONFIG_V2.mode,
  approvalTtlMinutes: DEFAULT_CONFIG_V2.approvalTtlMinutes,
  tokenPrefix: DEFAULT_CONFIG_V2.tokenPrefix,
  gates: { ...DEFAULT_CONFIG_V2.gates },
  classifier: {
    strictChains: DEFAULT_CONFIG_V2.classifier.strictChains,
    sensitivePaths: [...DEFAULT_CONFIG_V2.classifier.sensitivePaths],
  },
  policy: { ...DEFAULT_POLICY_V3 },
  overrides: { ...DEFAULT_OVERRIDES_V3 },
  redaction: { ...DEFAULT_REDACTION_V3 },
  controlPlane: { ...DEFAULT_CONTROL_PLANE_V3 },
  notifications: { ...DEFAULT_NOTIFICATIONS_V3 },
  approvalSigning: { ...DEFAULT_APPROVAL_SIGNING_V3 },
  approval: { ...DEFAULT_APPROVAL_CONFIG },
  egress: { ...DEFAULT_EGRESS_V3 },
  sandbox: { ...DEFAULT_SANDBOX_V3 },
  audit: { ...DEFAULT_CONFIG_V2.audit },
  judge: { ...DEFAULT_JUDGE_LOCAL_OLLAMA },
}

/** @deprecated Use DEFAULT_CONFIG_V4 */
export const DEFAULT_CONFIG_V3: BelayConfigV4 = DEFAULT_CONFIG_V4
