import path from 'node:path'
import {
  auditConfigForPersistence,
  auditConfigWithSourceRetention,
  normalizeAuditConfig,
} from './config/audit.js'
import {
  DEFAULT_APPROVAL_CONFIG,
  DEFAULT_APPROVAL_SIGNING_V3,
  DEFAULT_CAPABILITY_V5,
  DEFAULT_CONFIDENCE_THRESHOLDS,
  DEFAULT_CONFIG_V2,
  DEFAULT_CONFIG_V3,
  DEFAULT_CONFIG_V4,
  DEFAULT_CONTAINED_EXECUTION,
  DEFAULT_CONTROL_PLANE_ISOLATION_V3,
  DEFAULT_CONTROL_PLANE_V3,
  DEFAULT_EGRESS_V3,
  DEFAULT_FENCE_WARN_THRESHOLD,
  DEFAULT_FILE_CHECKPOINT,
  DEFAULT_JUDGE_LOCAL_OLLAMA,
  DEFAULT_MODEL_ASSIST,
  DEFAULT_NOTIFICATIONS_V3,
  DEFAULT_POLICY_V3,
  DEFAULT_RECOVERY_CHECKPOINT,
  DEFAULT_REDACTION_V3,
  DEFAULT_SANDBOX_V3,
  DEFAULT_TRANSACTIONAL_V3,
  LEGACY_CONTROL_PLANE_V3,
  LEGACY_POLICY_V3,
} from './config/defaults.js'
import { normalizeJudgeConfig, synthesizeJudgeFromRaw } from './config/judge.js'
import { resolveControlPlaneDir } from './config/paths.js'
import type {
  BelayCapabilityConfig,
  BelayConfigV1,
  BelayConfigV2,
  BelayConfigV4,
  BelayContainedExecutionConfig,
  BelayFileCheckpointConfig,
  BelayOverridesConfig,
  BelaySandboxConfig,
  RawConfigInput,
  SandboxRuntime,
} from './config/types.js'
import type { ClassifierOptions, ScrubOptions, UnknownLocalEffectPolicy } from './types.js'

export {
  auditRetentionFromConfig,
  DEFAULT_AUDIT_MAX_BYTES,
  DEFAULT_AUDIT_MAX_FILES,
  DEFAULT_AUDIT_RETENTION,
  MAX_AUDIT_FILES,
  normalizeAuditConfig,
  normalizeAuditRetention,
} from './config/audit.js'
export {
  DEFAULT_APPROVAL_CONFIG,
  DEFAULT_APPROVAL_SIGNING_V3,
  DEFAULT_CAPABILITY_V5,
  DEFAULT_CONFIDENCE_THRESHOLDS,
  DEFAULT_CONFIG_V2,
  DEFAULT_CONFIG_V3,
  DEFAULT_CONFIG_V4,
  DEFAULT_CONTAINED_EXECUTION,
  DEFAULT_CONTROL_PLANE_ISOLATION_V3,
  DEFAULT_CONTROL_PLANE_V3,
  DEFAULT_EGRESS_V3,
  DEFAULT_FENCE_WARN_THRESHOLD,
  DEFAULT_FILE_CHECKPOINT,
  DEFAULT_JUDGE_CURSOR_COMPOSER,
  DEFAULT_JUDGE_LOCAL_OLLAMA,
  DEFAULT_JUDGE_OPENAI_COMPATIBLE_TEMPLATE,
  DEFAULT_MODEL_ASSIST,
  DEFAULT_NOTIFICATIONS_V3,
  DEFAULT_OVERRIDES_V3,
  DEFAULT_POLICY_V3,
  DEFAULT_RECOVERY_CHECKPOINT,
  DEFAULT_REDACTION_V3,
  DEFAULT_SANDBOX_V3,
  DEFAULT_TRANSACTIONAL_V3,
  LEGACY_CONTROL_PLANE_V3,
  LEGACY_POLICY_V3,
} from './config/defaults.js'
export {
  normalizeJudgeConfig,
  normalizeJudgeProvider,
  rejectTeamLayerJudgeSecrets,
} from './config/judge.js'
export {
  approvedApprovalsFile,
  belayStateDir,
  configuredControlPlaneDir,
  defaultControlPlaneDir,
  pendingApprovalsFile,
  resolveControlPlaneDir,
} from './config/paths.js'
export type {
  ApprovalFlow,
  AuditRetentionConfig,
  BelayApprovalAutoReplayScopes,
  BelayApprovalConfig,
  BelayApprovalSigningConfig,
  BelayAuditConfig,
  BelayCapabilityConfig,
  BelayClassifierConfig,
  BelayConfidenceThresholds,
  BelayConfig,
  BelayConfigV1,
  BelayConfigV2,
  BelayConfigV3,
  BelayConfigV4,
  BelayContainedExecutionConfig,
  BelayControlPlaneConfig,
  BelayControlPlaneIsolationConfig,
  BelayEgressConfig,
  BelayFileCheckpointConfig,
  BelayJudgeConfig,
  BelayJudgeMode,
  BelayModelAssistConfig,
  BelayNotificationsConfig,
  BelayOverridesConfig,
  BelayPolicyConfig,
  BelayRedactionConfig,
  BelaySandboxConfig,
  BelayTransactionalConfig,
  ControlPlaneIsolationMode,
  DeprecatedJudgeProviderId,
  JudgeCloudConsent,
  JudgeCredentialConfig,
  JudgeCredentialMode,
  JudgeCredentialRef,
  JudgeProvider,
  JudgeProviderId,
  NormalizedBelayAuditConfig,
  SandboxRuntime,
} from './config/types.js'
export type { UnknownLocalEffectPolicy }

function normalizeCapabilityConfig(
  capability: BelayCapabilityConfig | undefined,
): BelayCapabilityConfig | undefined {
  if (!capability) {
    return undefined
  }
  return {
    ...DEFAULT_CAPABILITY_V5,
    ...capability,
    grantsEnabled: capability.grantsEnabled !== false,
    boundaryDriver: capability.boundaryDriver ?? DEFAULT_CAPABILITY_V5.boundaryDriver,
    attestationRelPath: capability.attestationRelPath ?? DEFAULT_CAPABILITY_V5.attestationRelPath,
  }
}

function clampCopyConcurrency(value: number): number {
  return Math.min(32, Math.max(1, Math.floor(value)))
}

export function normalizeFileCheckpointConfig(
  raw: Partial<BelayFileCheckpointConfig> | undefined,
): BelayFileCheckpointConfig {
  return {
    enabled: raw?.enabled === true,
    allowNonGit: raw?.allowNonGit === true,
    maxFiles:
      typeof raw?.maxFiles === 'number' && raw.maxFiles > 0
        ? Math.floor(raw.maxFiles)
        : DEFAULT_FILE_CHECKPOINT.maxFiles,
    maxSourceBytes:
      typeof raw?.maxSourceBytes === 'number' && raw.maxSourceBytes > 0
        ? Math.floor(raw.maxSourceBytes)
        : DEFAULT_FILE_CHECKPOINT.maxSourceBytes,
    maxWorkspaceBytes:
      typeof raw?.maxWorkspaceBytes === 'number' && raw.maxWorkspaceBytes > 0
        ? Math.floor(raw.maxWorkspaceBytes)
        : DEFAULT_FILE_CHECKPOINT.maxWorkspaceBytes,
    prepareTimeoutMs:
      typeof raw?.prepareTimeoutMs === 'number' && raw.prepareTimeoutMs > 0
        ? Math.floor(raw.prepareTimeoutMs)
        : DEFAULT_FILE_CHECKPOINT.prepareTimeoutMs,
    copyConcurrency:
      typeof raw?.copyConcurrency === 'number' && raw.copyConcurrency > 0
        ? clampCopyConcurrency(raw.copyConcurrency)
        : DEFAULT_FILE_CHECKPOINT.copyConcurrency,
  }
}

function positiveInteger(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : fallback
}

function positiveNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback
}

export function normalizeContainedExecutionConfig(
  raw: Partial<BelayContainedExecutionConfig> | undefined,
): BelayContainedExecutionConfig {
  return {
    enabled: raw?.enabled === true,
    image: typeof raw?.image === 'string' && raw.image.trim() ? raw.image.trim() : null,
    dockerExecutable:
      typeof raw?.dockerExecutable === 'string' && raw.dockerExecutable.trim()
        ? raw.dockerExecutable.trim()
        : null,
    dockerHost:
      typeof raw?.dockerHost === 'string' && raw.dockerHost.trim() ? raw.dockerHost.trim() : null,
    timeoutMs: positiveInteger(raw?.timeoutMs, DEFAULT_CONTAINED_EXECUTION.timeoutMs),
    memoryMiB: positiveInteger(raw?.memoryMiB, DEFAULT_CONTAINED_EXECUTION.memoryMiB),
    cpus: positiveNumber(raw?.cpus, DEFAULT_CONTAINED_EXECUTION.cpus),
    pids: positiveInteger(raw?.pids, DEFAULT_CONTAINED_EXECUTION.pids),
  }
}

function normalizeSandboxConfig(raw: Partial<BelaySandboxConfig> | undefined): BelaySandboxConfig {
  const runtime: SandboxRuntime =
    raw?.runtime === 'cursor-sandbox' ||
    raw?.runtime === 'container' ||
    raw?.runtime === 'seatbelt' ||
    raw?.runtime === 'landlock'
      ? raw.runtime
      : DEFAULT_SANDBOX_V3.runtime
  const containedExecution = normalizeContainedExecutionConfig(raw?.containedExecution)
  if (containedExecution.enabled && (raw?.enabled !== true || runtime !== 'container')) {
    throw new Error(
      'contained execution requires sandbox.runtime=container with sandbox.enabled=true',
    )
  }
  if (containedExecution.enabled && !containedExecution.image) {
    throw new Error('contained execution requires an explicit image')
  }
  if (containedExecution.enabled && !containedExecution.dockerExecutable) {
    throw new Error('contained execution requires an explicit Docker executable')
  }
  if (
    containedExecution.enabled &&
    (!path.isAbsolute(containedExecution.dockerExecutable ?? '') ||
      /[\0\n\r]/.test(containedExecution.dockerExecutable ?? ''))
  ) {
    throw new Error('contained execution requires an absolute executable path')
  }
  if (containedExecution.enabled && !containedExecution.dockerHost) {
    throw new Error('contained execution requires an explicit Docker host')
  }
  if (
    containedExecution.enabled &&
    (!containedExecution.dockerHost?.startsWith('unix:///') ||
      !path.isAbsolute(containedExecution.dockerHost.slice('unix://'.length)) ||
      /[\0\n\r]/.test(containedExecution.dockerHost))
  ) {
    throw new Error('contained execution requires a local unix Docker host')
  }
  return {
    enabled: raw?.enabled === true,
    runtime,
    denyNetworkByDefault: raw?.denyNetworkByDefault !== false,
    containedExecution,
  }
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
    approval: { ...DEFAULT_APPROVAL_CONFIG },
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
  const version =
    typeof value === 'object' && value !== null ? (value as BelayConfigV4).version : null
  return version === 4 || version === 5
}

export function migrateV3ToV4(v3: BelayConfigV4, raw?: RawConfigInput): BelayConfigV4 {
  return normalizeConfig({
    ...v3,
    version: 4,
    judge: synthesizeJudgeFromRaw({ ...(raw ?? {}), judge: raw?.judge ?? v3.judge }),
  })
}

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
    raw.audit?.includeAssessment !== undefined ||
    raw.audit?.maxBytes !== undefined ||
    raw.audit?.maxFiles !== undefined ||
    raw.audit?.retention !== undefined
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
    approval: {
      ...base.approval,
      ...(raw.approval ?? {}),
      autoReplayScopes: {
        ...base.approval.autoReplayScopes,
        ...(raw.approval?.autoReplayScopes ?? {}),
      },
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
    approval: {
      ...DEFAULT_APPROVAL_CONFIG,
      ...(raw.approval ?? {}),
      autoReplayScopes: {
        ...DEFAULT_APPROVAL_CONFIG.autoReplayScopes,
        ...(raw.approval?.autoReplayScopes ?? {}),
      },
    },
    egress: {
      ...DEFAULT_EGRESS_V3,
      ...(raw.egress ?? {}),
    },
    sandbox: {
      ...DEFAULT_SANDBOX_V3,
      ...(raw.sandbox ?? {}),
    },
    audit: auditConfigWithSourceRetention(DEFAULT_CONFIG_V3.audit, raw.audit),
  })
}

function normalizeV5Raw(raw: RawConfigInput): BelayConfigV4 {
  const base = normalizeV3Raw({ ...raw, version: 4 })
  return {
    ...base,
    version: 5,
    capability: {
      grantsEnabled: raw.capability?.grantsEnabled !== false,
      boundaryDriver: raw.capability?.boundaryDriver ?? 'host-integration',
      attestationRelPath: raw.capability?.attestationRelPath ?? '.belay/attestation.json',
      ...(raw.capability ?? {}),
    },
  }
}

export function migrateConfig(loaded: unknown): BelayConfigV4 {
  if (typeof loaded !== 'object' || loaded === null) {
    return { ...DEFAULT_CONFIG_V4 }
  }

  const raw = loaded as RawConfigInput

  if (raw.version === 4) {
    return normalizeV3Raw(raw)
  }

  if (raw.version === 5) {
    return normalizeV5Raw(raw)
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
    audit: auditConfigWithSourceRetention(baseV2.audit, raw.audit),
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
    audit: normalizeAuditConfig({
      ...DEFAULT_CONFIG_V2.audit,
      ...config.audit,
    }),
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
  const version: 4 | 5 = v4.version === 5 ? 5 : 4
  const normalized: BelayConfigV4 = {
    version,
    ...(v4.installScope === 'global' || v4.installScope === 'project'
      ? { installScope: v4.installScope }
      : {}),
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
      codexUnmappedTool: 'allow',
      fenceWarnThreshold:
        typeof v4.policy?.fenceWarnThreshold === 'number' &&
        v4.policy.fenceWarnThreshold > 0 &&
        v4.policy.fenceWarnThreshold <= 1
          ? v4.policy.fenceWarnThreshold
          : DEFAULT_FENCE_WARN_THRESHOLD,
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
          fileCheckpoint: normalizeFileCheckpointConfig(v4.policy?.transactional?.fileCheckpoint),
          checkpoint: {
            enabled: v4.policy?.transactional?.checkpoint?.enabled === true,
            appliedRetentionHours:
              typeof v4.policy?.transactional?.checkpoint?.appliedRetentionHours === 'number' &&
              v4.policy.transactional.checkpoint.appliedRetentionHours > 0
                ? v4.policy.transactional.checkpoint.appliedRetentionHours
                : DEFAULT_RECOVERY_CHECKPOINT.appliedRetentionHours,
            restoredRetentionHours:
              typeof v4.policy?.transactional?.checkpoint?.restoredRetentionHours === 'number' &&
              v4.policy.transactional.checkpoint.restoredRetentionHours > 0
                ? v4.policy.transactional.checkpoint.restoredRetentionHours
                : DEFAULT_RECOVERY_CHECKPOINT.restoredRetentionHours,
            maxCheckpoints:
              typeof v4.policy?.transactional?.checkpoint?.maxCheckpoints === 'number' &&
              v4.policy.transactional.checkpoint.maxCheckpoints > 0
                ? Math.floor(v4.policy.transactional.checkpoint.maxCheckpoints)
                : DEFAULT_RECOVERY_CHECKPOINT.maxCheckpoints,
            maxBytes:
              typeof v4.policy?.transactional?.checkpoint?.maxBytes === 'number' &&
              v4.policy.transactional.checkpoint.maxBytes > 0
                ? Math.floor(v4.policy.transactional.checkpoint.maxBytes)
                : DEFAULT_RECOVERY_CHECKPOINT.maxBytes,
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
      maskHighEntropyStrings: v4.redaction?.maskHighEntropyStrings !== false,
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
    approval: {
      flow: v4.approval?.flow === 'two_step' ? 'two_step' : DEFAULT_APPROVAL_CONFIG.flow,
      autoReplayScopes: {
        shell: v4.approval?.autoReplayScopes?.shell !== false,
        tool: v4.approval?.autoReplayScopes?.tool === true,
        subagent: v4.approval?.autoReplayScopes?.subagent === true,
      },
      executionLeaseMs:
        typeof v4.approval?.executionLeaseMs === 'number' && v4.approval.executionLeaseMs > 0
          ? v4.approval.executionLeaseMs
          : DEFAULT_APPROVAL_CONFIG.executionLeaseMs,
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
    sandbox: normalizeSandboxConfig(v4.sandbox),
    audit: normalizeAuditConfig({
      ...DEFAULT_CONFIG_V4.audit,
      ...v4.audit,
    }),
    judge: normalizeJudgeConfig(v4.judge ?? DEFAULT_JUDGE_LOCAL_OLLAMA),
  }
  if (version === 5 || v4.capability) {
    normalized.capability = normalizeCapabilityConfig(v4.capability ?? DEFAULT_CAPABILITY_V5)
  }
  return normalized
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

export function hasForbiddenShellOverrideLists(config: BelayConfigV4): boolean {
  return config.overrides.allow.length > 0 || config.overrides.external.length > 0
}

export function stripForbiddenShellOverrideLists(config: BelayConfigV4): BelayConfigV4 {
  if (!hasForbiddenShellOverrideLists(config)) {
    return config
  }
  return {
    ...config,
    overrides: {
      allow: [],
      external: [],
    },
  }
}

export function configForPersistence(config: BelayConfigV4): BelayConfigV4 {
  const stripped = stripForbiddenShellOverrideLists(config)
  const audit = auditConfigForPersistence(stripped.audit)
  return audit === stripped.audit ? stripped : { ...stripped, audit }
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
    approval: {
      ...defaults.approval,
      ...migrated.approval,
      autoReplayScopes: {
        ...defaults.approval.autoReplayScopes,
        ...migrated.approval.autoReplayScopes,
      },
    },
    egress: {
      ...defaults.egress,
      ...migrated.egress,
    },
    sandbox: {
      ...defaults.sandbox,
      ...migrated.sandbox,
      containedExecution: {
        ...(defaults.sandbox.containedExecution ?? DEFAULT_CONTAINED_EXECUTION),
        ...(migrated.sandbox.containedExecution ?? DEFAULT_CONTAINED_EXECUTION),
      },
    },
    audit: {
      ...defaults.audit,
      ...migrated.audit,
    },
    ...(migrated.installScope ? { installScope: migrated.installScope } : {}),
    ...(migrated.version === 5 || migrated.capability
      ? {
          version: migrated.version === 5 ? 5 : 4,
          capability: normalizeCapabilityConfig({
            ...DEFAULT_CAPABILITY_V5,
            ...migrated.capability,
          }),
        }
      : {}),
  })
}

export function scrubOptionsFromConfig(config: BelayConfigV4): ScrubOptions {
  return { ...config.redaction }
}

export function classifierOptionsFromConfig(config: BelayConfigV4): ClassifierOptions {
  return {
    strictChains: config.classifier.strictChains,
    sensitivePaths: config.classifier.sensitivePaths,
    unknownLocalEffect: config.policy.unknownLocalEffect,
    unparseableShell: config.policy.unparseableShell,
    confidenceThresholds: { ...config.policy.confidenceThresholds },
    controlPlaneDir: config.controlPlane.enabled ? resolveControlPlaneDir(config) : null,
    scrubOptions: scrubOptionsFromConfig(config),
    egressEnabled: config.egress.enabled,
  }
}
