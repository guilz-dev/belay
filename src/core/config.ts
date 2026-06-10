import path from 'node:path'

import type { ClassifierOptions, ScrubOptions } from './types.js'

export type BelayMode = 'enforce' | 'audit'

export type UnknownLocalEffectPolicy = 'allow_flagged' | 'deny'

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

export interface BelayPolicyConfig {
  unknownLocalEffect: UnknownLocalEffectPolicy
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

export interface BelayControlPlaneConfig {
  enabled: boolean
  configDir: string | null
}

export interface BelayClassifierConfig {
  strictChains: boolean
  sensitivePaths: string[]
}

export interface BelayConfigV3 {
  version: 3
  mode: BelayMode
  approvalTtlMinutes: number
  tokenPrefix: string
  gates: BelayConfigV2['gates']
  classifier: BelayClassifierConfig
  policy: BelayPolicyConfig
  overrides: BelayOverridesConfig
  redaction: BelayRedactionConfig
  controlPlane: BelayControlPlaneConfig
  audit: BelayConfigV2['audit']
}

export type BelayConfig = BelayConfigV3

export const DEFAULT_POLICY_V3: BelayPolicyConfig = {
  unknownLocalEffect: 'allow_flagged',
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

export const DEFAULT_CONTROL_PLANE_V3: BelayControlPlaneConfig = {
  enabled: false,
  configDir: null,
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
    logPath: '.cursor/belay/audit.ndjson',
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
    policy: { ...DEFAULT_POLICY_V3 },
    overrides: {
      allow: mergeOverrideLists(rawOverrides?.allow ?? [], legacyOverrides.allow),
      external: mergeOverrideLists(rawOverrides?.external ?? [], legacyOverrides.external),
    },
    redaction: { ...DEFAULT_REDACTION_V3 },
    controlPlane: { ...DEFAULT_CONTROL_PLANE_V3 },
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
      ...DEFAULT_CONFIG_V3.policy,
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
      ...DEFAULT_CONFIG_V3.controlPlane,
      ...(raw.controlPlane ?? {}),
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
        v3.policy?.unknownLocalEffect === 'deny' ? 'deny' : DEFAULT_POLICY_V3.unknownLocalEffect,
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
      enabled: v3.controlPlane?.enabled === true,
      configDir:
        typeof v3.controlPlane?.configDir === 'string' && v3.controlPlane.configDir.trim()
          ? v3.controlPlane.configDir.trim()
          : null,
    },
    audit: {
      logPath: v3.audit?.logPath || DEFAULT_CONFIG_V3.audit.logPath,
      includeAssessment: v3.audit?.includeAssessment !== false,
    },
  }
}

export function mergeConfig(
  existing: unknown,
  defaults: BelayConfigV3 = DEFAULT_CONFIG_V3,
): BelayConfigV3 {
  const migrated = migrateConfig(existing)
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
    controlPlaneDir: config.controlPlane.enabled ? resolveControlPlaneDir(config) : null,
  }
}

export function defaultControlPlaneDir(
  env: NodeJS.ProcessEnv = process.env,
  homedir: () => string = () => process.env.HOME ?? '',
): string {
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

export function belayStateDir(config: BelayConfigV3, repoRoot: string): string {
  if (config.controlPlane.enabled) {
    return resolveControlPlaneDir(config)
  }
  return path.join(repoRoot, '.cursor', 'belay')
}

export function pendingApprovalsFile(config: BelayConfigV3, repoRoot: string): string {
  return path.join(belayStateDir(config, repoRoot), 'pending-approvals.json')
}

export function approvedApprovalsFile(config: BelayConfigV3, repoRoot: string): string {
  return path.join(belayStateDir(config, repoRoot), 'approved-approvals.json')
}
