import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { normalizeJudgeProvider, scrubOptionsFromConfig } from '../config.js';
import { assertJudgeEndpoint } from '../judge-config.js';
import { createDeterministicJudgeStub, createOllamaJudge, createOpenAiCompatibleJudge, } from './judge.js';
const FIXTURE_MODELS_URL = new URL('../../../fixtures/judge-models.json', import.meta.url);
let cachedPinnedModels = null;
export function resetPinnedJudgeModelsCache() {
    cachedPinnedModels = null;
}
export async function loadPinnedJudgeModels() {
    if (cachedPinnedModels) {
        return cachedPinnedModels;
    }
    try {
        const raw = await readFile(fileURLToPath(FIXTURE_MODELS_URL), 'utf8');
        cachedPinnedModels = JSON.parse(raw);
        return cachedPinnedModels;
    }
    catch {
        cachedPinnedModels = {
            'openai-compatible': { autoResolved: 'composer-2.5' },
            ollama: { ciPin: 'gemma4:e2b' },
        };
        return cachedPinnedModels;
    }
}
export function resolveCloudModel(requested, pinned) {
    if (requested === 'auto') {
        const envResolved = process.env.BELAY_JUDGE_MODEL_RESOLVED?.trim();
        return {
            requested,
            resolved: envResolved || pinned.autoResolved,
        };
    }
    return { requested, resolved: requested };
}
/** @deprecated Use resolveCloudModel */
export const resolveCursorModel = resolveCloudModel;
export function createJudgeFromConfig(config, options = {}) {
    const judgeConfig = config.judge;
    const provider = normalizeJudgeProvider(judgeConfig.provider);
    if (provider === 'openai-compatible') {
        assertJudgeEndpoint(judgeConfig);
        const pinned = options.pinnedModels ?? { autoResolved: 'composer-2.5' };
        const { resolved } = resolveCloudModel(judgeConfig.model, pinned);
        return createOpenAiCompatibleJudge({
            endpoint: judgeConfig.endpoint,
            modelRequested: judgeConfig.model,
            modelResolved: resolved,
            timeoutMs: judgeConfig.timeoutMs,
            sensitivePaths: config.classifier.sensitivePaths,
            scrubOptions: scrubOptionsFromConfig(config),
        });
    }
    if (provider === 'ollama') {
        return createOllamaJudge({
            model: judgeConfig.model,
            baseUrl: judgeConfig.endpoint ?? 'http://127.0.0.1:11434',
            timeoutMs: judgeConfig.timeoutMs,
            keepAlive: judgeConfig.keepAlive,
        });
    }
    return createDeterministicJudgeStub();
}
export function judgeConfigSummary(judge) {
    return `${judge.provider}/${judge.model}`;
}
