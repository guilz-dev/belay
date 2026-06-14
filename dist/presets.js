import { DEFAULT_CONFIG_V3 } from './core/config.js';
export const CONFIG_PRESETS = {
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
};
export function applyConfigPreset(preset, extra = {}) {
    const base = CONFIG_PRESETS[preset] ?? CONFIG_PRESETS.standard;
    return {
        version: 3,
        ...base,
        ...extra,
        policy: {
            ...DEFAULT_CONFIG_V3.policy,
            ...(base.policy ?? {}),
            ...extra.policy,
        },
        sandbox: {
            ...DEFAULT_CONFIG_V3.sandbox,
            ...(base.sandbox ?? {}),
            ...extra.sandbox,
        },
        egress: {
            ...DEFAULT_CONFIG_V3.egress,
            ...(base.egress ?? {}),
            ...extra.egress,
        },
        approvalSigning: {
            ...DEFAULT_CONFIG_V3.approvalSigning,
            ...(base.approvalSigning ?? {}),
            ...extra.approvalSigning,
        },
        controlPlane: {
            ...DEFAULT_CONFIG_V3.controlPlane,
            ...(base.controlPlane ?? {}),
            ...extra.controlPlane,
            isolation: {
                ...DEFAULT_CONFIG_V3.controlPlane.isolation,
                ...(base.controlPlane?.isolation ?? {}),
                ...(extra.controlPlane
                    ?.isolation ?? {}),
            },
        },
    };
}
