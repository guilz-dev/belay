import type { BelayConfigV3 } from '../core/config.js';
import { GUARANTEE_SCENARIOS } from './guarantee-table.js';
import type { LayerProfileId } from './types.js';
export type { LayerConformanceScenario, LayerProfileId } from './types.js';
export { GUARANTEE_SCENARIOS };
export declare function layerProfileConfig(profile: LayerProfileId): BelayConfigV3;
export declare const LAYER_CONFORMANCE_SCENARIOS: Record<LayerProfileId, import("./types.js").LayerConformanceScenario[]>;
