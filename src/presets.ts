import type { BelayConfigV3 } from './core/config.js'
import { DEFAULT_CONFIG_V3 } from './core/config.js'

export type ConfigPresetName = 'strict' | 'standard' | 'audit-first'

export const CONFIG_PRESETS: Record<ConfigPresetName, Partial<BelayConfigV3>> = {
  strict: {
    mode: 'enforce',
    policy: {
      unknownLocalEffect: 'deny',
      unparseableShell: 'deny',
      confidenceThresholds: { allow: 0.9, flag: 0.8 },
      modelAssist: { enabled: false },
    },
  },
  standard: {
    mode: 'enforce',
  },
  'audit-first': {
    mode: 'audit',
    policy: {
      unknownLocalEffect: 'deny',
      unparseableShell: 'deny',
      confidenceThresholds: { allow: 0.88, flag: 0.72 },
      modelAssist: { enabled: false },
    },
  },
}

export function applyConfigPreset(
  preset: ConfigPresetName,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  const base = CONFIG_PRESETS[preset] ?? CONFIG_PRESETS.standard
  return {
    version: 3,
    ...base,
    ...extra,
    policy: {
      ...DEFAULT_CONFIG_V3.policy,
      ...(base.policy ?? {}),
      ...(extra.policy as Record<string, unknown> | undefined),
    },
  }
}
