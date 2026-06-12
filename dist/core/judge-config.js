export const JUDGE_PROFILE_CURSOR_COMPOSER = {
    provider: 'cursor',
    model: 'auto',
    timeoutMs: 8000,
    endpoint: null,
    keepAlive: null,
};
export const JUDGE_PROFILE_LOCAL_OLLAMA = {
    provider: 'ollama',
    model: 'gemma4:e2b',
    endpoint: 'http://localhost:11434',
    timeoutMs: 25000,
    keepAlive: '30m',
};
export const JUDGE_PROFILES = {
    'cursor-composer': JUDGE_PROFILE_CURSOR_COMPOSER,
    'local-ollama': JUDGE_PROFILE_LOCAL_OLLAMA,
};
export function resolveJudgeConfig(input = {}) {
    if (input.judgeProvider) {
        const base = input.judgeProvider === 'cursor' ? JUDGE_PROFILE_CURSOR_COMPOSER : JUDGE_PROFILE_LOCAL_OLLAMA;
        return {
            ...base,
            model: input.judgeModel ?? base.model,
        };
    }
    if (input.judgeProfile) {
        const profile = JUDGE_PROFILES[input.judgeProfile];
        return {
            ...profile,
            model: input.judgeModel ?? profile.model,
        };
    }
    if (input.existingJudge) {
        return { ...input.existingJudge };
    }
    return { ...JUDGE_PROFILE_CURSOR_COMPOSER };
}
