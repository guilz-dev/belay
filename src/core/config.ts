import type { ClassifierOptions } from './types.js'

export type BelayMode = 'enforce' | 'audit'

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

export type BelayConfig = BelayConfigV2

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

export function isConfigV1(value: unknown): value is BelayConfigV1 {
  return typeof value === 'object' && value !== null && (value as BelayConfigV1).version === 1
}

export function migrateConfig(loaded: unknown): BelayConfigV2 {
  if (typeof loaded !== 'object' || loaded === null) {
    return { ...DEFAULT_CONFIG_V2 }
  }

  const raw = loaded as Partial<{
    version: number
    mode: BelayMode
    approvalTtlMinutes: number
    tokenPrefix: string
    gates: Partial<BelayConfigV2['gates']>
    classifier: Partial<BelayConfigV2['classifier']>
    audit: Partial<BelayConfigV2['audit']>
  }>
  const base = { ...DEFAULT_CONFIG_V2 }

  if (raw.version === 1 || raw.version === undefined) {
    return normalizeConfig({
      ...base,
      mode: raw.mode ?? base.mode,
      approvalTtlMinutes: raw.approvalTtlMinutes ?? base.approvalTtlMinutes,
      tokenPrefix: raw.tokenPrefix ?? base.tokenPrefix,
      gates: {
        ...base.gates,
        shell: raw.gates?.shell ?? base.gates.shell,
        subagent: raw.gates?.subagent ?? base.gates.subagent,
      },
      audit: {
        ...base.audit,
        logPath: raw.audit?.logPath ?? base.audit.logPath,
      },
    })
  }

  return normalizeConfig({
    ...base,
    ...raw,
    version: 2,
    gates: {
      ...base.gates,
      ...(raw.gates ?? {}),
    },
    classifier: {
      ...base.classifier,
      ...(raw.classifier ?? {}),
    },
    audit: {
      ...base.audit,
      ...(raw.audit ?? {}),
    },
  })
}

export function normalizeConfig(config: BelayConfigV2): BelayConfigV2 {
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

export function mergeConfig(
  existing: unknown,
  defaults: BelayConfigV2 = DEFAULT_CONFIG_V2,
): BelayConfigV2 {
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
    audit: {
      ...defaults.audit,
      ...migrated.audit,
    },
  })
}

export function classifierOptionsFromConfig(config: BelayConfigV2): ClassifierOptions {
  return {
    strictChains: config.classifier.strictChains,
    customExternalCommands: config.classifier.customExternalCommands,
    customAllowCommands: config.classifier.customAllowCommands,
    sensitivePaths: config.classifier.sensitivePaths,
  }
}
