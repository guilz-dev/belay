import type { BelayConfigV4, BelayJudgeConfig } from '../config.js';
import { type TracedTier1Judge } from './judge.js';
export declare function resetPinnedJudgeModelsCache(): void;
export declare function loadPinnedJudgeModels(): Promise<{
    'openai-compatible': {
        autoResolved: string;
    };
    ollama: {
        ciPin: string;
    };
}>;
export declare function resolveCloudModel(requested: string, pinned: {
    autoResolved: string;
}): {
    requested: string;
    resolved: string;
};
/** @deprecated Use resolveCloudModel */
export declare const resolveCursorModel: typeof resolveCloudModel;
export declare function createJudgeFromConfig(config: BelayConfigV4, options?: {
    pinnedModels?: {
        autoResolved: string;
    };
}): TracedTier1Judge;
export declare function judgeConfigSummary(judge: BelayJudgeConfig): string;
