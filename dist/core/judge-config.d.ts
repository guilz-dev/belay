import type { BelayJudgeConfig } from './config.js';
export type JudgeProfileName = 'local-ollama';
export declare const JUDGE_PROFILE_LOCAL_OLLAMA: BelayJudgeConfig;
export declare const JUDGE_PROFILES: Record<JudgeProfileName, BelayJudgeConfig>;
export interface ResolveJudgeConfigInput {
    judgeProfile?: JudgeProfileName;
    judgeProvider?: 'ollama' | 'openai-compatible' | 'cursor';
    judgeModel?: string;
    judgeEndpoint?: string;
    existingJudge?: BelayJudgeConfig;
}
export declare function resolveJudgeConfig(input?: ResolveJudgeConfigInput): BelayJudgeConfig;
export declare class CloudJudgeConsentRequiredError extends Error {
    constructor();
}
export declare class JudgeEndpointRequiredError extends Error {
    constructor();
}
export declare function assertJudgeEndpoint(judge: BelayJudgeConfig): void;
export declare function resolveInitJudgeConfig(input: {
    isFresh: boolean;
    hasExplicitJudgeFlags: boolean;
    judgeProfile?: JudgeProfileName;
    judgeProvider?: 'ollama' | 'openai-compatible' | 'cursor';
    judgeModel?: string;
    judgeEndpoint?: string;
    acceptCloudJudge?: boolean;
    existingJudge?: BelayJudgeConfig;
}): BelayJudgeConfig;
