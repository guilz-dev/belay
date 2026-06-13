import path from 'node:path'

import type {
  ClassifierOptions,
  ControlPlaneIntegrity,
  ScrubOptions,
  UnknownLocalEffectPolicy,
  UnparseableShellPolicy,
} from './types.js'

export type BelayMode = 'enforce' | 'audit'

export type { UnknownLocalEffectPolicy }

export interface BelayConfigV1 {
  version: 1
  mode: BelayMode
  approvalTtlMinutes: number
  tokenPrefix: string
  gates: {
    shell: boolean
    subagent: boolean
  }
  audit: {
    logPath: string
  }
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
  audit: {
    logPath: string
    includeAssessment: boolean
  }
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

export interface BelayTransactionalConfig {
  enabled: boolean
  minConfidence: number
  maxConfidence: number
  timeoutMs: number
  maxDeletionCount: number
  gates: {
    shell: boolean
  }
}

export interface BelayPolicyConfig {
  unknownLocalEffect: UnknownLocalEffectPolicy
  unparseableShell: UnparseableShellPolicy
  confidenceThresholds: BelayConfidenceThresholds
  modelAssist: BelayModelAssistConfig
  transactional: BelayTransactionalConfig
  // Codex adapter (experimental): how to treat a PreToolUse tool whose name belay does not yet
  // map to a known kind. 'deny' (default) is the fail-closed floor — an unmapped tool must not
  // silently bypass the gate (FN=0). 'allow' is the opt-out: pass the tool but record it to the
  // audit log for vocabulary learning (use only if fail-closed over-blocks in practice). See
  // SPEC-v2.2 R-X1. Optional; runtime defaults to 'deny' when absent.
  codexUnmappedTool?: 'allow' | 'deny'
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

export type JudgeProvider = 'ollama' | 'openai-compatible'

export interface BelayJudgeConfig {
  provider: JudgeProvider
  model: string
  timeoutMs: number
  endpoint: string | null
  keepAlive: string | null
}

export const DEFAULT_JUDGE_LOCAL_OLLAMA: BelayJudgeConfig = {
  provider: 'ollama',
  model: 'gemma4:e2b',
  endpoint: 'http://localhost:11434',
  timeoutMs: 25000,
  keepAlive: '30m',
}

export const DEFAULT_JUDGE_OPENAI_COMPATIBLE_TEMPLATE: BelayJudgeConfig = {
  provider: 'openai-compatible',
  model: 'auto',
  timeoutMs: 8000,
  endpoint: null,
  keepAlive: null,
}

/** @deprecated Use DEFAULT_JUDGE_OPENAI_COMPATIBLE_TEMPLATE */
export const DEFAULT_JUDGE_CURSOR_COMPOSER = DEFAULT_JUDGE_OPENAI_COMPATIBLE_TEMPLATE

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

export interface BelayEgressConfig {
  enabled: boolean
  listenHost: string
  listenPort: number
  /** When true with egress enabled, L3 external command lists become hints only. */
  demoteL3External: boolean
}

export interface BelayConfigV4 {
  version: 4
  adapter?: 'cursor' | 'claude' | 'codex'
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
  egress: BelayEgressConfig
  sandbox: BelaySandboxConfig
  audit: BelayConfigV2['audit']
  judge: BelayJudgeConfig
}

/** @deprecated Use BelayConfigV4 */
export type BelayConfigV3 = BelayConfigV4

export type BelayConfig = BelayConfigV4

/** Pre-v0.4 defaults preserved when migrating existing v1/v2/v3 configs. */
export const DEFAULT_CONFIDENCE_THRESHOLDS: BelayConfidenceThresholds = {
  allow: 0.88,
  flag: 0.72,
}

export const DEFAULT_MODEL_ASSIST: BelayModelAssistConfig = {
  enabled: false,
  timeoutMs: 3000,
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
}

export const LEGACY_POLICY_V3: BelayPolicyConfig = {
  unknownLocalEffect: 'allow_flagged',
  unparseableShell: 'allow_flagged',
  confidenceThresholds: { ...DEFAULT_CONFIDENCE_THRESHOLDS },
  modelAssist: { ...DEFAULT_MODEL_ASSIST },
  transactional: { ...DEFAULT_TRANSACTIONAL_V3 },
}

/** Fresh v0.4+ install defaults (fail-closed). */
export const DEFAULT_POLICY_V3: BelayPolicyConfig = {
  unknownLocalEffect: 'deny',
  unparseableShell: 'deny',
  codexUnmappedTool: 'deny',
  confidenceThresholds: { ...DEFAULT_CONFIDENCE_THRESHOLDS },
  modelAssist: { ...DEFAULT_MODEL_ASSIST },
  transactional: { ...DEFAULT_TRANSACTIONAL_V3 },
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
  maskHighEntropyStrings: false,
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

export const DEFAULT_SANDBOX_V3: BelaySandboxConfig = {
  enabled: false,
  runtime: 'none',
  denyNetworkByDefault: true,
}

export const DEFAULT_NOTIFICATIONS_V3: BelayNotificationsConfig = {}

export const DEFAULT_APPROVAL_SIGNING_V3: BelayApprovalSigningConfig = {
  required: false,
}

export const DEFAULT_EGRESS_V3: BelayEgressConfig = {
  enabled: false,
  listenHost: '127.0.0.1',
  listenPort: 17831,
  demoteL3External: true,
}

const LOOPBACK_EGRESS_HOSTS = new Set(['127.0.0.1', 'localhost', '::1'])

export function normalizeEgressListenHost(host: string): string {
  const trimmed = host.trim()
  const lowered = trimmed.toLowerCase()
  if (LOOPBACK_EGRESS_HOSTS.has(lowered)) {
    return lowered === 'localhost' ? '127.0.0.1' : trimmed
  }
  return DEFAULT_EGRESS_V3.listenHost
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
  egress: { ...DEFAULT_EGRESS_V3 },
  sandbox: { ...DEFAULT_SANDBOX_V3 },
  audit: { ...DEFAULT_CONFIG_V2.audit },
  judge: { ...DEFAULT_JUDGE_LOCAL_OLLAMA },
}

/** @deprecated Use DEFAULT_CONFIG_V4 */
export const DEFAULT_CONFIG_V3: BelayConfigV4 = DEFAULT_CONFIG_V4

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)]
}

function mergeOverrideLists(primary: string[], secondary: string[]): string[] {
  return uniqueStrings([...primary, ...secondary])
}

export function mapLegacyClassifierToOverrides(classifier: {
  customAllowCommands?: string[]
  customExternalCommands?: string[]
}): BelayOverridesConfig {
  return {
    allow: Array.isArray(classifier.customAllowCommands) ? classifier.customAllowCommands : [],
    external: Array.isArray(classifier.customExternalCommands)
      ? classifier.customExternalCommands
      : [],
  }
}

export function migrateV2ToV3(
  v2: BelayConfigV2,
  rawOverrides?: Partial<BelayOverridesConfig>,
): BelayConfigV4 {
  const legacyOverrides = mapLegacyClassifierToOverrides(v2.classifier)
  return normalizeConfig({
    version: 4,
    mode: v2.mode,
    approvalTtlMinutes: v2.approvalTtlMinutes,
    tokenPrefix: v2.tokenPrefix,
    gates: v2.gates,
    classifier: {
      strictChains: v2.classifier.strictChains,
      sensitivePaths: v2.classifier.sensitivePaths,
    },
    policy: { ...LEGACY_POLICY_V3 },
    overrides: {
      allow: mergeOverrideLists(rawOverrides?.allow ?? [], legacyOverrides.allow),
      external: mergeOverrideLists(rawOverrides?.external ?? [], legacyOverrides.external),
    },
    redaction: { ...DEFAULT_REDACTION_V3 },
    controlPlane: { ...LEGACY_CONTROL_PLANE_V3 },
    notifications: { ...DEFAULT_NOTIFICATIONS_V3 },
    approvalSigning: { ...DEFAULT_APPROVAL_SIGNING_V3 },
    egress: { ...DEFAULT_EGRESS_V3 },
    sandbox: { ...DEFAULT_SANDBOX_V3 },
    audit: v2.audit,
    judge: { ...DEFAULT_JUDGE_LOCAL_OLLAMA },
  })
}

export function isConfigV1(value: unknown): value is BelayConfigV1 {
  return typeof value === 'object' && value !== null && (value as BelayConfigV1).version === 1
}

export function isConfigV2(value: unknown): value is BelayConfigV2 {
  return typeof value === 'object' && value !== null && (value as BelayConfigV2).version === 2
}

export function isConfigV3(value: unknown): value is BelayConfigV4 {
  if (typeof value !== 'object' || value === null) {
    return false
  }
  const version = (value as { version?: number }).version
  return version === 3 || version === 4
}

export function isConfigV4(value: unknown): value is BelayConfigV4 {
  return typeof value === 'object' && value !== null && (value as BelayConfigV4).version === 4
}

export function normalizeJudgeProvider(
  provider: string | undefined,
): 'ollama' | 'openai-compatible' {
  if (provider === 'openai-compatible' || provider === 'cursor') {
    return 'openai-compatible'
  }
  return 'ollama'
}

function synthesizeJudgeFromRaw(raw: RawConfigInput): BelayJudgeConfig {
  const judge = raw.judge as (Partial<BelayJudgeConfig> & { provider?: string }) | undefined
  if (judge?.provider) {
    const provider = normalizeJudgeProvider(judge.provider)
    const base =
      provider === 'openai-compatible'
        ? DEFAULT_JUDGE_OPENAI_COMPATIBLE_TEMPLATE
        : DEFAULT_JUDGE_LOCAL_OLLAMA
    return normalizeJudgeConfig({
      ...base,
      ...judge,
      provider,
    })
  }
  return { ...DEFAULT_JUDGE_LOCAL_OLLAMA }
}

export function normalizeJudgeConfig(judge: BelayJudgeConfig): BelayJudgeConfig {
  const provider = normalizeJudgeProvider(judge.provider)
  const base =
    provider === 'openai-compatible'
      ? DEFAULT_JUDGE_OPENAI_COMPATIBLE_TEMPLATE
      : DEFAULT_JUDGE_LOCAL_OLLAMA
  const model =
    typeof judge.model === 'string' && judge.model.trim() ? judge.model.trim() : base.model
  const timeoutMs =
    typeof judge.timeoutMs === 'number' && judge.timeoutMs > 0 ? judge.timeoutMs : base.timeoutMs
  return {
    provider,
    model,
    timeoutMs,
    endpoint:
      typeof judge.endpoint === 'string' && judge.endpoint.trim() ? judge.endpoint.trim() : null,
    keepAlive:
      provider === 'ollama' && typeof judge.keepAlive === 'string' && judge.keepAlive.trim()
        ? judge.keepAlive.trim()
        : provider === 'ollama'
          ? DEFAULT_JUDGE_LOCAL_OLLAMA.keepAlive
          : null,
  }
}

export function migrateV3ToV4(v3: BelayConfigV4, raw?: RawConfigInput): BelayConfigV4 {
  return normalizeConfig({
    ...v3,
    version: 4,
    judge: synthesizeJudgeFromRaw({ ...(raw ?? {}), judge: raw?.judge ?? v3.judge }),
  })
}

type RawConfigInput = Partial<{
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
  egress: Partial<BelayEgressConfig>
  sandbox: Partial<BelaySandboxConfig>
  audit: Partial<BelayConfigV2['audit']>
}>

function hasV3Sections(raw: RawConfigInput): boolean {
  return (
    raw.policy !== undefined ||
    raw.overrides !== undefined ||
    raw.redaction !== undefined ||
    raw.controlPlane !== undefined
  )
}

function looksLikeV2Config(raw: RawConfigInput): boolean {
  return (
    raw.gates?.fileMutation !== undefined ||
    raw.gates?.toolShell !== undefined ||
    raw.classifier?.customAllowCommands !== undefined ||
    raw.classifier?.customExternalCommands !== undefined ||
    raw.audit?.includeAssessment !== undefined
  )
}

function mergeV3FromRaw(base: BelayConfigV4, raw: RawConfigInput): BelayConfigV4 {
  return normalizeConfig({
    ...base,
    judge: raw.judge ? { ...base.judge, ...raw.judge } : base.judge,
    policy: {
      ...base.policy,
      ...(raw.policy ?? {}),
    },
    overrides: {
      allow: mergeOverrideLists(base.overrides.allow, raw.overrides?.allow ?? []),
      external: mergeOverrideLists(base.overrides.external, raw.overrides?.external ?? []),
    },
    redaction: {
      ...base.redaction,
      ...(raw.redaction ?? {}),
    },
    controlPlane: {
      ...base.controlPlane,
      ...(raw.controlPlane ?? {}),
    },
    notifications: {
      ...base.notifications,
      ...(raw.notifications ?? {}),
    },
    approvalSigning: {
      ...base.approvalSigning,
      ...(raw.approvalSigning ?? {}),
    },
    egress: {
      ...base.egress,
      ...(raw.egress ?? {}),
    },
    sandbox: {
      ...base.sandbox,
      ...(raw.sandbox ?? {}),
    },
  })
}

function normalizeV3Raw(raw: RawConfigInput): BelayConfigV4 {
  return normalizeConfig({
    ...DEFAULT_CONFIG_V4,
    ...raw,
    version: 4,
    judge: synthesizeJudgeFromRaw(raw),
    gates: {
      ...DEFAULT_CONFIG_V3.gates,
      ...(raw.gates ?? {}),
    },
    classifier: {
      ...DEFAULT_CONFIG_V3.classifier,
      ...(raw.classifier ?? {}),
    },
    policy: {
      ...LEGACY_POLICY_V3,
      ...(raw.policy ?? {}),
    },
    overrides: {
      ...DEFAULT_CONFIG_V3.overrides,
      ...(raw.overrides ?? {}),
    },
    redaction: {
      ...DEFAULT_CONFIG_V3.redaction,
      ...(raw.redaction ?? {}),
    },
    controlPlane: {
      ...LEGACY_CONTROL_PLANE_V3,
      ...(raw.controlPlane ?? {}),
      isolation: {
        ...LEGACY_CONTROL_PLANE_V3.isolation,
        ...(raw.controlPlane?.isolation ?? {}),
      },
    },
    notifications: {
      ...DEFAULT_NOTIFICATIONS_V3,
      ...(raw.notifications ?? {}),
    },
    approvalSigning: {
      required: raw.approvalSigning?.required === true,
    },
    egress: {
      ...DEFAULT_EGRESS_V3,
      ...(raw.egress ?? {}),
    },
    sandbox: {
      ...DEFAULT_SANDBOX_V3,
      ...(raw.sandbox ?? {}),
    },
    audit: {
      ...DEFAULT_CONFIG_V3.audit,
      ...(raw.audit ?? {}),
    },
  })
}

export function migrateConfig(loaded: unknown): BelayConfigV4 {
  if (typeof loaded !== 'object' || loaded === null) {
    return { ...DEFAULT_CONFIG_V4 }
  }

  const raw = loaded as RawConfigInput

  if (raw.version === 4) {
    return normalizeV3Raw(raw)
  }

  if (raw.version === 3 || (raw.version === undefined && hasV3Sections(raw))) {
    return normalizeV3Raw(raw)
  }

  const baseV2 = { ...DEFAULT_CONFIG_V2 }

  if (raw.version === 1 || (raw.version === undefined && !looksLikeV2Config(raw))) {
    const migratedV2 = normalizeConfigV2({
      ...baseV2,
      mode: raw.mode ?? baseV2.mode,
      approvalTtlMinutes: raw.approvalTtlMinutes ?? baseV2.approvalTtlMinutes,
      tokenPrefix: raw.tokenPrefix ?? baseV2.tokenPrefix,
      gates: {
        ...baseV2.gates,
        shell: raw.gates?.shell ?? baseV2.gates.shell,
        subagent: raw.gates?.subagent ?? baseV2.gates.subagent,
      },
      audit: {
        ...baseV2.audit,
        logPath: raw.audit?.logPath ?? baseV2.audit.logPath,
      },
    })
    return mergeV3FromRaw(migrateV2ToV3(migratedV2, raw.overrides), raw)
  }

  const migratedV2 = normalizeConfigV2({
    ...baseV2,
    ...raw,
    version: 2,
    gates: {
      ...baseV2.gates,
      ...(raw.gates ?? {}),
    },
    classifier: {
      ...baseV2.classifier,
      ...(raw.classifier ?? {}),
    },
    audit: {
      ...baseV2.audit,
      ...(raw.audit ?? {}),
    },
  })

  return mergeV3FromRaw(migrateV2ToV3(migratedV2, raw.overrides), raw)
}

export function normalizeConfigV2(config: BelayConfigV2): BelayConfigV2 {
  return {
    version: 2,
    mode: config.mode === 'audit' ? 'audit' : 'enforce',
    approvalTtlMinutes:
      typeof config.approvalTtlMinutes === 'number' && config.approvalTtlMinutes > 0
        ? config.approvalTtlMinutes
        : DEFAULT_CONFIG_V2.approvalTtlMinutes,
    tokenPrefix: config.tokenPrefix || DEFAULT_CONFIG_V2.tokenPrefix,
    gates: {
      shell: config.gates.shell !== false,
      subagent: config.gates.subagent !== false,
      fileMutation: config.gates.fileMutation !== false,
      toolShell: config.gates.toolShell !== false,
    },
    classifier: {
      strictChains: config.classifier?.strictChains !== false,
      customExternalCommands: Array.isArray(config.classifier?.customExternalCommands)
        ? config.classifier.customExternalCommands
        : [],
      customAllowCommands: Array.isArray(config.classifier?.customAllowCommands)
        ? config.classifier.customAllowCommands
        : [],
      sensitivePaths: Array.isArray(config.classifier?.sensitivePaths)
        ? config.classifier.sensitivePaths
        : DEFAULT_CONFIG_V2.classifier.sensitivePaths,
    },
    audit: {
      logPath: config.audit?.logPath || DEFAULT_CONFIG_V2.audit.logPath,
      includeAssessment: config.audit?.includeAssessment !== false,
    },
  }
}

export function normalizeConfig(config: BelayConfigV4): BelayConfigV4
export function normalizeConfig(config: BelayConfigV2): BelayConfigV2
export function normalizeConfig(
  config: BelayConfigV2 | BelayConfigV4,
): BelayConfigV2 | BelayConfigV4 {
  if (config.version === 2) {
    return normalizeConfigV2(config)
  }

  const v4 = config as BelayConfigV4
  return {
    version: 4,
    mode: v4.mode === 'audit' ? 'audit' : 'enforce',
    approvalTtlMinutes:
      typeof v4.approvalTtlMinutes === 'number' && v4.approvalTtlMinutes > 0
        ? v4.approvalTtlMinutes
        : DEFAULT_CONFIG_V4.approvalTtlMinutes,
    tokenPrefix: v4.tokenPrefix || DEFAULT_CONFIG_V4.tokenPrefix,
    gates: {
      shell: v4.gates.shell !== false,
      subagent: v4.gates.subagent !== false,
      fileMutation: v4.gates.fileMutation !== false,
      toolShell: v4.gates.toolShell !== false,
    },
    classifier: {
      strictChains: v4.classifier?.strictChains !== false,
      sensitivePaths: Array.isArray(v4.classifier?.sensitivePaths)
        ? v4.classifier.sensitivePaths
        : DEFAULT_CONFIG_V4.classifier.sensitivePaths,
    },
    policy: {
      unknownLocalEffect:
        v4.policy?.unknownLocalEffect === 'deny'
          ? 'deny'
          : v4.policy?.unknownLocalEffect === 'allow_flagged'
            ? 'allow_flagged'
            : DEFAULT_POLICY_V3.unknownLocalEffect,
      unparseableShell:
        v4.policy?.unparseableShell === 'deny'
          ? 'deny'
          : v4.policy?.unparseableShell === 'allow_flagged'
            ? 'allow_flagged'
            : DEFAULT_POLICY_V3.unparseableShell,
      codexUnmappedTool: v4.policy?.codexUnmappedTool === 'allow' ? 'allow' : 'deny',
      confidenceThresholds: {
        allow:
          typeof v4.policy?.confidenceThresholds?.allow === 'number'
            ? v4.policy.confidenceThresholds.allow
            : DEFAULT_CONFIDENCE_THRESHOLDS.allow,
        flag:
          typeof v4.policy?.confidenceThresholds?.flag === 'number'
            ? v4.policy.confidenceThresholds.flag
            : DEFAULT_CONFIDENCE_THRESHOLDS.flag,
      },
      modelAssist: {
        enabled: v4.policy?.modelAssist?.enabled === true,
        model: v4.policy?.modelAssist?.model,
        timeoutMs:
          typeof v4.policy?.modelAssist?.timeoutMs === 'number'
            ? v4.policy.modelAssist.timeoutMs
            : DEFAULT_MODEL_ASSIST.timeoutMs,
      },
      transactional: (() => {
        let minConfidence =
          typeof v4.policy?.transactional?.minConfidence === 'number'
            ? v4.policy.transactional.minConfidence
            : DEFAULT_TRANSACTIONAL_V3.minConfidence
        let maxConfidence =
          typeof v4.policy?.transactional?.maxConfidence === 'number'
            ? v4.policy.transactional.maxConfidence
            : DEFAULT_TRANSACTIONAL_V3.maxConfidence
        if (minConfidence >= maxConfidence) {
          minConfidence = DEFAULT_TRANSACTIONAL_V3.minConfidence
          maxConfidence = DEFAULT_TRANSACTIONAL_V3.maxConfidence
        }
        return {
          enabled: v4.policy?.transactional?.enabled === true,
          minConfidence,
          maxConfidence,
          timeoutMs:
            typeof v4.policy?.transactional?.timeoutMs === 'number' &&
            v4.policy.transactional.timeoutMs > 0
              ? v4.policy.transactional.timeoutMs
              : DEFAULT_TRANSACTIONAL_V3.timeoutMs,
          maxDeletionCount:
            typeof v4.policy?.transactional?.maxDeletionCount === 'number' &&
            v4.policy.transactional.maxDeletionCount >= 0
              ? v4.policy.transactional.maxDeletionCount
              : DEFAULT_TRANSACTIONAL_V3.maxDeletionCount,
          gates: {
            shell: v4.policy?.transactional?.gates?.shell !== false,
          },
        }
      })(),
    },
    overrides: {
      allow: Array.isArray(v4.overrides?.allow) ? uniqueStrings(v4.overrides.allow) : [],
      external: Array.isArray(v4.overrides?.external) ? uniqueStrings(v4.overrides.external) : [],
    },
    redaction: {
      maskApprovalIds: v4.redaction?.maskApprovalIds !== false,
      maskBearerTokens: v4.redaction?.maskBearerTokens !== false,
      maskAuthHeaders: v4.redaction?.maskAuthHeaders !== false,
      maskKeyValueSecrets: v4.redaction?.maskKeyValueSecrets !== false,
      maskHighEntropyStrings: v4.redaction?.maskHighEntropyStrings === true,
    },
    controlPlane: {
      enabled:
        v4.controlPlane?.enabled === true
          ? true
          : v4.controlPlane?.enabled === false
            ? false
            : DEFAULT_CONTROL_PLANE_V3.enabled,
      configDir:
        typeof v4.controlPlane?.configDir === 'string' && v4.controlPlane.configDir.trim()
          ? v4.controlPlane.configDir.trim()
          : null,
      integrity:
        v4.controlPlane?.integrity === 'hash-pinned'
          ? 'hash-pinned'
          : v4.controlPlane?.integrity === 'none'
            ? 'none'
            : DEFAULT_CONTROL_PLANE_V3.integrity,
      isolation: {
        mode:
          v4.controlPlane?.isolation?.mode === 'read-only-mount' ||
          v4.controlPlane?.isolation?.mode === 'separate-user'
            ? v4.controlPlane.isolation.mode
            : DEFAULT_CONTROL_PLANE_ISOLATION_V3.mode,
        expectedOwnerUid:
          typeof v4.controlPlane?.isolation?.expectedOwnerUid === 'number'
            ? v4.controlPlane.isolation.expectedOwnerUid
            : undefined,
        verifyAgentWritable: v4.controlPlane?.isolation?.verifyAgentWritable !== false,
      },
    },
    notifications: {
      webhookUrl:
        typeof v4.notifications?.webhookUrl === 'string' && v4.notifications.webhookUrl.trim()
          ? v4.notifications.webhookUrl.trim()
          : undefined,
      commandHook:
        typeof v4.notifications?.commandHook === 'string' && v4.notifications.commandHook.trim()
          ? v4.notifications.commandHook.trim()
          : undefined,
    },
    approvalSigning: {
      required: v4.approvalSigning?.required === true,
    },
    egress: {
      enabled: v4.egress?.enabled === true,
      listenHost: normalizeEgressListenHost(
        typeof v4.egress?.listenHost === 'string' && v4.egress.listenHost.trim()
          ? v4.egress.listenHost.trim()
          : DEFAULT_EGRESS_V3.listenHost,
      ),
      listenPort:
        typeof v4.egress?.listenPort === 'number' && v4.egress.listenPort > 0
          ? v4.egress.listenPort
          : DEFAULT_EGRESS_V3.listenPort,
      demoteL3External: v4.egress?.demoteL3External !== false,
    },
    sandbox: {
      enabled: v4.sandbox?.enabled === true,
      runtime:
        v4.sandbox?.runtime === 'cursor-sandbox' ||
        v4.sandbox?.runtime === 'container' ||
        v4.sandbox?.runtime === 'seatbelt' ||
        v4.sandbox?.runtime === 'landlock'
          ? v4.sandbox.runtime
          : DEFAULT_SANDBOX_V3.runtime,
      denyNetworkByDefault: v4.sandbox?.denyNetworkByDefault !== false,
    },
    audit: {
      logPath: v4.audit?.logPath || DEFAULT_CONFIG_V4.audit.logPath,
      includeAssessment: v4.audit?.includeAssessment !== false,
    },
    judge: normalizeJudgeConfig(v4.judge ?? DEFAULT_JUDGE_LOCAL_OLLAMA),
  }
}

export function isFreshConfigInput(loaded: unknown): boolean {
  if (loaded === null || loaded === undefined) {
    return true
  }
  if (typeof loaded !== 'object') {
    return true
  }
  return Object.keys(loaded as Record<string, unknown>).length === 0
}

export function mergeConfig(
  existing: unknown,
  defaults: BelayConfigV4 = DEFAULT_CONFIG_V4,
): BelayConfigV4 {
  const migrated = isFreshConfigInput(existing)
    ? normalizeConfig({ ...defaults, version: 4 })
    : migrateConfig(existing)
  return normalizeConfig({
    ...defaults,
    ...migrated,
    judge: migrated.judge ?? defaults.judge,
    gates: {
      ...defaults.gates,
      ...migrated.gates,
    },
    classifier: {
      ...defaults.classifier,
      ...migrated.classifier,
    },
    policy: {
      ...defaults.policy,
      ...migrated.policy,
    },
    overrides: {
      allow: mergeOverrideLists(defaults.overrides.allow, migrated.overrides.allow),
      external: mergeOverrideLists(defaults.overrides.external, migrated.overrides.external),
    },
    redaction: {
      ...defaults.redaction,
      ...migrated.redaction,
    },
    controlPlane: {
      ...defaults.controlPlane,
      ...migrated.controlPlane,
    },
    notifications: {
      ...defaults.notifications,
      ...migrated.notifications,
    },
    approvalSigning: {
      ...defaults.approvalSigning,
      ...migrated.approvalSigning,
    },
    egress: {
      ...defaults.egress,
      ...migrated.egress,
    },
    sandbox: {
      ...defaults.sandbox,
      ...migrated.sandbox,
    },
    audit: {
      ...defaults.audit,
      ...migrated.audit,
    },
  })
}

export function scrubOptionsFromConfig(config: BelayConfigV4): ScrubOptions {
  return { ...config.redaction }
}

export function classifierOptionsFromConfig(config: BelayConfigV4): ClassifierOptions {
  return {
    strictChains: config.classifier.strictChains,
    customExternalCommands: config.overrides.external,
    customAllowCommands: config.overrides.allow,
    sensitivePaths: config.classifier.sensitivePaths,
    unknownLocalEffect: config.policy.unknownLocalEffect,
    unparseableShell: config.policy.unparseableShell,
    confidenceThresholds: { ...config.policy.confidenceThresholds },
    controlPlaneDir: config.controlPlane.enabled ? resolveControlPlaneDir(config) : null,
    scrubOptions: scrubOptionsFromConfig(config),
    egressEnabled: config.egress.enabled,
  }
}

export function defaultControlPlaneDir(
  env: NodeJS.ProcessEnv = process.env,
  homedir: () => string = () => env.HOME ?? env.USERPROFILE ?? '',
): string {
  if (process.platform === 'win32') {
    const appData = env.APPDATA?.trim()
    if (appData) {
      return path.join(appData, 'agent-belay')
    }
  }
  const xdgConfigHome = env.XDG_CONFIG_HOME?.trim()
  const base = xdgConfigHome || path.join(homedir(), '.config')
  return path.join(base, 'agent-belay')
}

export function resolveControlPlaneDir(config: BelayConfigV4): string {
  if (config.controlPlane.configDir) {
    return config.controlPlane.configDir
  }
  return defaultControlPlaneDir()
}

/** Control-plane directory regardless of enabled flag (for orphan migration). */
export function configuredControlPlaneDir(config: BelayConfigV4): string {
  return resolveControlPlaneDir(config)
}

export function belayStateDir(config: BelayConfigV4, repoLocalStateDir: string): string {
  if (config.controlPlane.enabled) {
    return resolveControlPlaneDir(config)
  }
  return repoLocalStateDir
}

export function pendingApprovalsFile(config: BelayConfigV4, repoLocalStateDir: string): string {
  return path.join(belayStateDir(config, repoLocalStateDir), 'pending-approvals.json')
}

export function approvedApprovalsFile(config: BelayConfigV4, repoLocalStateDir: string): string {
  return path.join(belayStateDir(config, repoLocalStateDir), 'approved-approvals.json')
}
