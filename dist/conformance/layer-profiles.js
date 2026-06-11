import { DEFAULT_CONFIG_V3 } from '../core/config.js';
import { GUARANTEE_SCENARIOS, layerConformanceScenarios } from './guarantee-table.js';
export { GUARANTEE_SCENARIOS };
export function layerProfileConfig(profile) {
    const base = {
        ...DEFAULT_CONFIG_V3,
        policy: {
            ...DEFAULT_CONFIG_V3.policy,
            unknownLocalEffect: 'allow_flagged',
        },
    };
    if (profile === 'l3-l4-only') {
        return base;
    }
    if (profile === 'l1-partial-egress') {
        return {
            ...base,
            egress: { ...base.egress, enabled: true, demoteL3External: true },
        };
    }
    if (profile === 'l1-l2-transactional') {
        return {
            ...base,
            policy: {
                ...base.policy,
                transactional: { ...base.policy.transactional, enabled: true },
            },
        };
    }
    return {
        ...base,
        sandbox: { ...base.sandbox, enabled: true, runtime: 'container' },
        egress: { ...base.egress, enabled: true, demoteL3External: true },
        approvalSigning: { required: true },
        controlPlane: {
            ...base.controlPlane,
            isolation: {
                ...base.controlPlane.isolation,
                mode: 'separate-user',
                verifyAgentWritable: true,
            },
        },
    };
}
export const LAYER_CONFORMANCE_SCENARIOS = layerConformanceScenarios();
