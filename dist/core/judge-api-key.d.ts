export declare function resolveJudgeApiKey(env?: NodeJS.ProcessEnv): {
    key: string | null;
    source: 'BELAY_JUDGE_API_KEY' | 'OPENAI_API_KEY' | null;
};
