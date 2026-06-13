import type { BelayConfigV4, BelayJudgeConfig } from '../config.js';
import { type TracedTier1Judge } from './judge.js';
export declare function loadPinnedJudgeModels(): Promise<{
    cursor: {
        autoResolved: string;
    };
    ollama: {
        ciPin: string;
    };
}>;
export declare function resolveCursorModel(requested: string, pinned: {
    autoResolved: string;
}): {
    requested: string;
    resolved: string;
};
export declare function createJudgeFromConfig(config: BelayConfigV4, options?: {
    pinnedModels?: {
        autoResolved: string;
    };
}): TracedTier1Judge;
export declare function judgeConfigSummary(judge: BelayJudgeConfig): string;
