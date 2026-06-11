import type { LayerConformanceScenario, LayerProfileId } from './types.js';
export type { LayerConformanceScenario, LayerProfileId } from './types.js';
export interface GuaranteeTableRow {
    profile: LayerProfileId;
    layersActive: string;
    cooperative: string;
    adversarial: string;
}
export interface GuaranteeScenario extends LayerConformanceScenario {
    id: string;
}
/** Normative rows — keep in sync with docs/guarantee-table.md */
export declare const GUARANTEE_TABLE_ROWS: GuaranteeTableRow[];
export declare const GUARANTEE_SCENARIOS: Record<LayerProfileId, GuaranteeScenario[]>;
export declare function layerConformanceScenarios(): Record<LayerProfileId, LayerConformanceScenario[]>;
