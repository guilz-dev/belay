import type { BelayJudgeConfig } from './config.js';
export type JudgeProfileName = 'cursor-composer' | 'local-ollama';
export declare const JUDGE_PROFILE_CURSOR_COMPOSER: BelayJudgeConfig;
export declare const JUDGE_PROFILE_LOCAL_OLLAMA: BelayJudgeConfig;
export declare const JUDGE_PROFILES: Record<JudgeProfileName, BelayJudgeConfig>;
export interface ResolveJudgeConfigInput {
    judgeProfile?: JudgeProfileName;
    judgeProvider?: 'cursor' | 'ollama';
    judgeModel?: string;
    existingJudge?: BelayJudgeConfig;
}
export declare function resolveJudgeConfig(input?: ResolveJudgeConfigInput): BelayJudgeConfig;
export declare class CloudJudgeConsentRequiredError extends Error {
    constructor();
}
export declare function resolveInitJudgeConfig(input: {
    isFresh: boolean;
    hasExplicitJudgeFlags: boolean;
    judgeProfile?: JudgeProfileName;
    judgeProvider?: 'cursor' | 'ollama';
    judgeModel?: string;
    acceptCloudJudge?: boolean;
    existingJudge?: BelayJudgeConfig;
}): BelayJudgeConfig;
