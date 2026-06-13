import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

import type { BelayConfigV4, BelayJudgeConfig } from '../config.js'
import { normalizeJudgeProvider, scrubOptionsFromConfig } from '../config.js'
import {
  createDeterministicJudgeStub,
  createFailClosedJudge,
  createOllamaJudge,
  createOpenAiCompatibleJudge,
  type TracedTier1Judge,
} from './judge.js'

const FIXTURE_MODELS_URL = new URL('../../../fixtures/judge-models.json', import.meta.url)

let cachedPinnedModels: {
  'openai-compatible': { autoResolved: string }
  ollama: { ciPin: string }
} | null = null

export function resetPinnedJudgeModelsCache(): void {
  cachedPinnedModels = null
}

export async function loadPinnedJudgeModels(): Promise<{
  'openai-compatible': { autoResolved: string }
  ollama: { ciPin: string }
}> {
  if (cachedPinnedModels) {
    return cachedPinnedModels
  }
  try {
    const raw = await readFile(fileURLToPath(FIXTURE_MODELS_URL), 'utf8')
    cachedPinnedModels = JSON.parse(raw) as {
      'openai-compatible': { autoResolved: string }
      ollama: { ciPin: string }
    }
    return cachedPinnedModels
  } catch {
    cachedPinnedModels = {
      'openai-compatible': { autoResolved: 'composer-2.5' },
      ollama: { ciPin: 'gemma4:e2b' },
    }
    return cachedPinnedModels
  }
}

export function resolveCloudModel(
  requested: string,
  pinned: { autoResolved: string },
): { requested: string; resolved: string } {
  if (requested === 'auto') {
    const envResolved = process.env.BELAY_JUDGE_MODEL_RESOLVED?.trim()
    return {
      requested,
      resolved: envResolved || pinned.autoResolved,
    }
  }
  return { requested, resolved: requested }
}

/** @deprecated Use resolveCloudModel */
export const resolveCursorModel = resolveCloudModel

export function createJudgeFromConfig(
  config: BelayConfigV4,
  options: { pinnedModels?: { autoResolved: string } } = {},
): TracedTier1Judge {
  const judgeConfig = config.judge
  const provider = normalizeJudgeProvider(judgeConfig.provider)

  if (provider === 'openai-compatible') {
    const endpoint = judgeConfig.endpoint?.trim()
    if (!endpoint) {
      return createFailClosedJudge({
        reason: 'openai_compatible_endpoint_missing',
        fallbackReason: 'missing_endpoint',
        modelRequested: judgeConfig.model,
        modelResolved: judgeConfig.model,
      })
    }
    const pinned = options.pinnedModels ?? { autoResolved: 'composer-2.5' }
    const { resolved } = resolveCloudModel(judgeConfig.model, pinned)
    return createOpenAiCompatibleJudge({
      endpoint,
      modelRequested: judgeConfig.model,
      modelResolved: resolved,
      timeoutMs: judgeConfig.timeoutMs,
      sensitivePaths: config.classifier.sensitivePaths,
      scrubOptions: scrubOptionsFromConfig(config),
    })
  }

  if (provider === 'ollama') {
    return createOllamaJudge({
      model: judgeConfig.model,
      baseUrl: judgeConfig.endpoint ?? 'http://127.0.0.1:11434',
      timeoutMs: judgeConfig.timeoutMs,
      keepAlive: judgeConfig.keepAlive,
    })
  }

  return createDeterministicJudgeStub()
}

export function judgeConfigSummary(judge: BelayJudgeConfig): string {
  return `${judge.provider}/${judge.model}`
}
