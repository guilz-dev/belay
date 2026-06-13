import type { BelayConfigV3 } from './core/config.js';
export interface DogfoodStatus {
    active: boolean;
    mode: string;
    unknownLocalEffect: string;
    readyForEnforce: boolean;
    gateEvents: number;
    wouldBlockCount: number;
    wouldBlockRate: number;
    notes: string[];
}
export interface OperationalInsights {
    repoRoot: string;
    dogfood: DogfoodStatus;
}
export declare function isDogfoodConfig(config: BelayConfigV3): boolean;
export declare function loadOperationalInsights(options?: {
    targetDir?: string;
}): Promise<OperationalInsights>;
