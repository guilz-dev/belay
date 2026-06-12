import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { scrubOptionsFromConfig } from '../config.js';
import { createCursorJudge, createDeterministicJudgeStub, createOllamaJudge, } from './judge.js';
const FIXTURE_MODELS_URL = new URL('../../../fixtures/judge-models.json', import.meta.url);
let cachedPinnedModels = null;
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
            cursor: { autoResolved: 'composer-2.5' },
            ollama: { ciPin: 'gemma4:e2b' },
        };
        return cachedPinnedModels;
    }
}
export function resolveCursorModel(requested, pinned) {
    if (requested === 'auto') {
        const envResolved = process.env.CURSOR_JUDGE_MODEL_RESOLVED?.trim();
        return {
            requested,
            resolved: envResolved || pinned.autoResolved,
        };
    }
    return { requested, resolved: requested };
}
export function createJudgeFromConfig(config, options = {}) {
    const judgeConfig = config.judge;
    if (judgeConfig.provider === 'cursor') {
        const pinned = options.pinnedModels ?? { autoResolved: 'composer-2.5' };
        const { resolved } = resolveCursorModel(judgeConfig.model, pinned);
        return createCursorJudge({
            modelRequested: judgeConfig.model,
            modelResolved: resolved,
            timeoutMs: judgeConfig.timeoutMs,
            endpoint: judgeConfig.endpoint,
            sensitivePaths: config.classifier.sensitivePaths,
            scrubOptions: scrubOptionsFromConfig(config),
        });
    }
    if (judgeConfig.provider === 'ollama') {
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
