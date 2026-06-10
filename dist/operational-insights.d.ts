import { type BelayConfigV3 } from './core/config.js';
export interface Oq3SpikeStatus {
    path: string;
    ok: boolean;
    recordedAt: string | null;
    error: string | null;
    controlPlaneDir: string;
}
export interface DogfoodStatus {
    active: boolean;
    mode: string;
    unknownLocalEffect: string;
    spikeOnPrompt: boolean;
    readyForEnforce: boolean;
    gateEvents: number;
    wouldBlockCount: number;
    wouldBlockRate: number;
    notes: string[];
}
export interface OperationalInsights {
    repoRoot: string;
    dogfood: DogfoodStatus;
    oq3Spike: Oq3SpikeStatus | null;
}
export declare function isDogfoodConfig(config: BelayConfigV3): boolean;
export declare function readOq3SpikeStatus(config: BelayConfigV3): Promise<Oq3SpikeStatus | null>;
export declare function loadOperationalInsights(options?: {
    targetDir?: string;
}): Promise<OperationalInsights>;
