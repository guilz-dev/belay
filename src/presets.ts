import type { BelayConfigV3 } from './core/config.js'
import { DEFAULT_CONFIG_V3 } from './core/config.js'

export type ConfigPresetName = 'strict' | 'standard' | 'audit-first' | 'l1-full-recommended'

export const CONFIG_PRESETS: Record<ConfigPresetName, Partial<BelayConfigV3>> = {
  strict: {
    mode: 'enforce',
    policy: {
      ...DEFAULT_CONFIG_V3.policy,
      unknownLocalEffect: 'deny',
      unparseableShell: 'deny',
      confidenceThresholds: { allow: 0.9, flag: 0.8 },
      modelAssist: { enabled: false },
    },
    sandbox: { ...DEFAULT_CONFIG_V3.sandbox },
  },
  standard: {
    mode: 'enforce',
  },
  'audit-first': {
    mode: 'audit',
    policy: {
      ...DEFAULT_CONFIG_V3.policy,
      unknownLocalEffect: 'deny',
      unparseableShell: 'deny',
      confidenceThresholds: { allow: 0.88, flag: 0.72 },
      modelAssist: { enabled: false },
    },
    sandbox: { ...DEFAULT_CONFIG_V3.sandbox },
  },
  'l1-full-recommended': {
    mode: 'enforce',
    policy: {
      ...DEFAULT_CONFIG_V3.policy,
      confidenceThresholds: { ...DEFAULT_CONFIG_V3.policy.confidenceThresholds },
      modelAssist: { ...DEFAULT_CONFIG_V3.policy.modelAssist },
    },
    sandbox: {
      enabled: true,
      runtime: 'container',
      denyNetworkByDefault: true,
    },
    egress: {
      ...DEFAULT_CONFIG_V3.egress,
      enabled: true,
      demoteL3External: true,
    },
    approvalSigning: {
      required: true,
    },
    controlPlane: {
      ...DEFAULT_CONFIG_V3.controlPlane,
      isolation: {
        mode: 'separate-user',
        verifyAgentWritable: true,
      },
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
    sandbox: {
      ...DEFAULT_CONFIG_V3.sandbox,
      ...(base.sandbox ?? {}),
      ...(extra.sandbox as Record<string, unknown> | undefined),
    },
    egress: {
      ...DEFAULT_CONFIG_V3.egress,
      ...(base.egress ?? {}),
      ...(extra.egress as Record<string, unknown> | undefined),
    },
    approvalSigning: {
      ...DEFAULT_CONFIG_V3.approvalSigning,
      ...(base.approvalSigning ?? {}),
      ...(extra.approvalSigning as Record<string, unknown> | undefined),
    },
    controlPlane: {
      ...DEFAULT_CONFIG_V3.controlPlane,
      ...(base.controlPlane ?? {}),
      ...(extra.controlPlane as Record<string, unknown> | undefined),
      isolation: {
        ...DEFAULT_CONFIG_V3.controlPlane.isolation,
        ...(base.controlPlane?.isolation ?? {}),
        ...((extra.controlPlane as { isolation?: Record<string, unknown> } | undefined)
          ?.isolation ?? {}),
      },
    },
  }
}
