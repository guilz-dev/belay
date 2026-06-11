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
  /** Run OQ3 control-plane filesystem spike on beforeSubmitPrompt (dogfood / validation). */
  spikeOnPrompt?: boolean
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

export interface BelayConfigV3 {
  version: 3
  adapter?: 'cursor' | 'claude'
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
}

export type BelayConfig = BelayConfigV3

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
  spikeOnPrompt: false,
  isolation: { ...DEFAULT_CONTROL_PLANE_ISOLATION_V3 },
}

export const DEFAULT_CONTROL_PLANE_V3: BelayControlPlaneConfig = {
  enabled: true,
  configDir: null,
  integrity: 'hash-pinned',
  spikeOnPrompt: false,
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

export const DEFAULT_CONFIG_V3: BelayConfigV3 = {
  version: 3,
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
}

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
): BelayConfigV3 {
  const legacyOverrides = mapLegacyClassifierToOverrides(v2.classifier)
  return normalizeConfig({
    version: 3,
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
  })
}

export function isConfigV1(value: unknown): value is BelayConfigV1 {
  return typeof value === 'object' && value !== null && (value as BelayConfigV1).version === 1
}

export function isConfigV2(value: unknown): value is BelayConfigV2 {
  return typeof value === 'object' && value !== null && (value as BelayConfigV2).version === 2
}

export function isConfigV3(value: unknown): value is BelayConfigV3 {
  return typeof value === 'object' && value !== null && (value as BelayConfigV3).version === 3
}

type RawConfigInput = Partial<{
  version: number
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

function mergeV3FromRaw(base: BelayConfigV3, raw: RawConfigInput): BelayConfigV3 {
  return normalizeConfig({
    ...base,
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

function normalizeV3Raw(raw: RawConfigInput): BelayConfigV3 {
  return normalizeConfig({
    ...DEFAULT_CONFIG_V3,
    ...raw,
    version: 3,
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

export function migrateConfig(loaded: unknown): BelayConfigV3 {
  if (typeof loaded !== 'object' || loaded === null) {
    return { ...DEFAULT_CONFIG_V3 }
  }

  const raw = loaded as RawConfigInput

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

/** @deprecated Use normalizeConfig for v3 configs. */
export function normalizeConfig(config: BelayConfigV3): BelayConfigV3
export function normalizeConfig(config: BelayConfigV2): BelayConfigV2
export function normalizeConfig(
  config: BelayConfigV2 | BelayConfigV3,
): BelayConfigV2 | BelayConfigV3 {
  if (config.version === 2) {
    return normalizeConfigV2(config)
  }

  const v3 = config as BelayConfigV3
  return {
    version: 3,
    mode: v3.mode === 'audit' ? 'audit' : 'enforce',
    approvalTtlMinutes:
      typeof v3.approvalTtlMinutes === 'number' && v3.approvalTtlMinutes > 0
        ? v3.approvalTtlMinutes
        : DEFAULT_CONFIG_V3.approvalTtlMinutes,
    tokenPrefix: v3.tokenPrefix || DEFAULT_CONFIG_V3.tokenPrefix,
    gates: {
      shell: v3.gates.shell !== false,
      subagent: v3.gates.subagent !== false,
      fileMutation: v3.gates.fileMutation !== false,
      toolShell: v3.gates.toolShell !== false,
    },
    classifier: {
      strictChains: v3.classifier?.strictChains !== false,
      sensitivePaths: Array.isArray(v3.classifier?.sensitivePaths)
        ? v3.classifier.sensitivePaths
        : DEFAULT_CONFIG_V3.classifier.sensitivePaths,
    },
    policy: {
      unknownLocalEffect:
        v3.policy?.unknownLocalEffect === 'deny'
          ? 'deny'
          : v3.policy?.unknownLocalEffect === 'allow_flagged'
            ? 'allow_flagged'
            : DEFAULT_POLICY_V3.unknownLocalEffect,
      unparseableShell:
        v3.policy?.unparseableShell === 'deny'
          ? 'deny'
          : v3.policy?.unparseableShell === 'allow_flagged'
            ? 'allow_flagged'
            : DEFAULT_POLICY_V3.unparseableShell,
      confidenceThresholds: {
        allow:
          typeof v3.policy?.confidenceThresholds?.allow === 'number'
            ? v3.policy.confidenceThresholds.allow
            : DEFAULT_CONFIDENCE_THRESHOLDS.allow,
        flag:
          typeof v3.policy?.confidenceThresholds?.flag === 'number'
            ? v3.policy.confidenceThresholds.flag
            : DEFAULT_CONFIDENCE_THRESHOLDS.flag,
      },
      modelAssist: {
        enabled: v3.policy?.modelAssist?.enabled === true,
        model: v3.policy?.modelAssist?.model,
        timeoutMs:
          typeof v3.policy?.modelAssist?.timeoutMs === 'number'
            ? v3.policy.modelAssist.timeoutMs
            : DEFAULT_MODEL_ASSIST.timeoutMs,
      },
      transactional: (() => {
        let minConfidence =
          typeof v3.policy?.transactional?.minConfidence === 'number'
            ? v3.policy.transactional.minConfidence
            : DEFAULT_TRANSACTIONAL_V3.minConfidence
        let maxConfidence =
          typeof v3.policy?.transactional?.maxConfidence === 'number'
            ? v3.policy.transactional.maxConfidence
            : DEFAULT_TRANSACTIONAL_V3.maxConfidence
        if (minConfidence >= maxConfidence) {
          minConfidence = DEFAULT_TRANSACTIONAL_V3.minConfidence
          maxConfidence = DEFAULT_TRANSACTIONAL_V3.maxConfidence
        }
        return {
          enabled: v3.policy?.transactional?.enabled === true,
          minConfidence,
          maxConfidence,
          timeoutMs:
            typeof v3.policy?.transactional?.timeoutMs === 'number' &&
            v3.policy.transactional.timeoutMs > 0
              ? v3.policy.transactional.timeoutMs
              : DEFAULT_TRANSACTIONAL_V3.timeoutMs,
          maxDeletionCount:
            typeof v3.policy?.transactional?.maxDeletionCount === 'number' &&
            v3.policy.transactional.maxDeletionCount >= 0
              ? v3.policy.transactional.maxDeletionCount
              : DEFAULT_TRANSACTIONAL_V3.maxDeletionCount,
          gates: {
            shell: v3.policy?.transactional?.gates?.shell !== false,
          },
        }
      })(),
    },
    overrides: {
      allow: Array.isArray(v3.overrides?.allow) ? uniqueStrings(v3.overrides.allow) : [],
      external: Array.isArray(v3.overrides?.external) ? uniqueStrings(v3.overrides.external) : [],
    },
    redaction: {
      maskApprovalIds: v3.redaction?.maskApprovalIds !== false,
      maskBearerTokens: v3.redaction?.maskBearerTokens !== false,
      maskAuthHeaders: v3.redaction?.maskAuthHeaders !== false,
      maskKeyValueSecrets: v3.redaction?.maskKeyValueSecrets !== false,
      maskHighEntropyStrings: v3.redaction?.maskHighEntropyStrings === true,
    },
    controlPlane: {
      enabled:
        v3.controlPlane?.enabled === true
          ? true
          : v3.controlPlane?.enabled === false
            ? false
            : DEFAULT_CONTROL_PLANE_V3.enabled,
      configDir:
        typeof v3.controlPlane?.configDir === 'string' && v3.controlPlane.configDir.trim()
          ? v3.controlPlane.configDir.trim()
          : null,
      integrity:
        v3.controlPlane?.integrity === 'hash-pinned'
          ? 'hash-pinned'
          : v3.controlPlane?.integrity === 'none'
            ? 'none'
            : DEFAULT_CONTROL_PLANE_V3.integrity,
      spikeOnPrompt: v3.controlPlane?.spikeOnPrompt === true,
      isolation: {
        mode:
          v3.controlPlane?.isolation?.mode === 'read-only-mount' ||
          v3.controlPlane?.isolation?.mode === 'separate-user'
            ? v3.controlPlane.isolation.mode
            : DEFAULT_CONTROL_PLANE_ISOLATION_V3.mode,
        expectedOwnerUid:
          typeof v3.controlPlane?.isolation?.expectedOwnerUid === 'number'
            ? v3.controlPlane.isolation.expectedOwnerUid
            : undefined,
        verifyAgentWritable: v3.controlPlane?.isolation?.verifyAgentWritable !== false,
      },
    },
    notifications: {
      webhookUrl:
        typeof v3.notifications?.webhookUrl === 'string' && v3.notifications.webhookUrl.trim()
          ? v3.notifications.webhookUrl.trim()
          : undefined,
      commandHook:
        typeof v3.notifications?.commandHook === 'string' && v3.notifications.commandHook.trim()
          ? v3.notifications.commandHook.trim()
          : undefined,
    },
    approvalSigning: {
      required: v3.approvalSigning?.required === true,
    },
    egress: {
      enabled: v3.egress?.enabled === true,
      listenHost: normalizeEgressListenHost(
        typeof v3.egress?.listenHost === 'string' && v3.egress.listenHost.trim()
          ? v3.egress.listenHost.trim()
          : DEFAULT_EGRESS_V3.listenHost,
      ),
      listenPort:
        typeof v3.egress?.listenPort === 'number' && v3.egress.listenPort > 0
          ? v3.egress.listenPort
          : DEFAULT_EGRESS_V3.listenPort,
      demoteL3External: v3.egress?.demoteL3External !== false,
    },
    sandbox: {
      enabled: v3.sandbox?.enabled === true,
      runtime:
        v3.sandbox?.runtime === 'cursor-sandbox' ||
        v3.sandbox?.runtime === 'container' ||
        v3.sandbox?.runtime === 'seatbelt' ||
        v3.sandbox?.runtime === 'landlock'
          ? v3.sandbox.runtime
          : DEFAULT_SANDBOX_V3.runtime,
      denyNetworkByDefault: v3.sandbox?.denyNetworkByDefault !== false,
    },
    audit: {
      logPath: v3.audit?.logPath || DEFAULT_CONFIG_V3.audit.logPath,
      includeAssessment: v3.audit?.includeAssessment !== false,
    },
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
  defaults: BelayConfigV3 = DEFAULT_CONFIG_V3,
): BelayConfigV3 {
  const migrated = isFreshConfigInput(existing)
    ? normalizeConfig({ ...defaults, version: 3 })
    : migrateConfig(existing)
  return normalizeConfig({
    ...defaults,
    ...migrated,
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

export function scrubOptionsFromConfig(config: BelayConfigV3): ScrubOptions {
  return { ...config.redaction }
}

export function classifierOptionsFromConfig(config: BelayConfigV3): ClassifierOptions {
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

export function resolveControlPlaneDir(config: BelayConfigV3): string {
  if (config.controlPlane.configDir) {
    return config.controlPlane.configDir
  }
  return defaultControlPlaneDir()
}

/** Control-plane directory regardless of enabled flag (for orphan migration). */
export function configuredControlPlaneDir(config: BelayConfigV3): string {
  return resolveControlPlaneDir(config)
}

export function belayStateDir(config: BelayConfigV3, repoLocalStateDir: string): string {
  if (config.controlPlane.enabled) {
    return resolveControlPlaneDir(config)
  }
  return repoLocalStateDir
}

export function pendingApprovalsFile(config: BelayConfigV3, repoLocalStateDir: string): string {
  return path.join(belayStateDir(config, repoLocalStateDir), 'pending-approvals.json')
}

export function approvedApprovalsFile(config: BelayConfigV3, repoLocalStateDir: string): string {
  return path.join(belayStateDir(config, repoLocalStateDir), 'approved-approvals.json')
}
