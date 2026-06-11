import type { BelayConfigV3 } from '../core/config.js';
export type LayerProfileId = 'l3-l4-only' | 'l1-partial-egress' | 'l1-l2-transactional' | 'l1-full';
export interface LayerConformanceScenario {
    command: string;
    permission: 'allow' | 'deny';
    reason?: string;
}
export declare function layerProfileConfig(profile: LayerProfileId): BelayConfigV3;
export declare const LAYER_CONFORMANCE_SCENARIOS: Record<LayerProfileId, LayerConformanceScenario[]>;
