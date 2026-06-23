import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { repoLocalStateDirFor } from '../../config-io.js'
import type { BelayConfigV4, BelayJudgeConfig } from '../config.js'
import { belayStateDir, normalizeJudgeProvider, scrubOptionsFromConfig } from '../config.js'
import { resolveJudgeCredential } from '../judge-api-key.js'
import { hasValidCloudConsent, isCloudJudgeConfig } from '../judge-config.js'
import { rejectDeprecatedJudgeModelAuto } from '../judge-model-policy.js'
import { detectJudgeRuntimeCapabilities } from '../judge-runtime-detection.js'
import {
  createDeterministicJudgeStub,
  createFailClosedJudge,
  createOllamaJudge,
  createOpenAiCompatibleJudge,
  type TracedTier1Judge,
} from './judge.js'
import {
  getJudgeProviderSpec,
  inferProviderIdFromConfig,
  isRemovedProviderId,
  type JudgeProviderId,
  normalizeLegacyProviderId,
} from './judge-catalog.js'
import { createClaudeCliJudge, createCodexCliJudge, createCursorCliJudge } from './judge-cli.js'

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

export function resolveJudgeModel(judge: BelayJudgeConfig): {
  requested: string
  resolved: string
} {
  rejectDeprecatedJudgeModelAuto(judge.model)
  const requested = judge.model
  const envOverride = testJudgeModelOverride()
  return { requested, resolved: envOverride || requested }
}

function testJudgeModelOverride(): string | undefined {
  if (!process.env.VITEST && !process.env.VITEST_WORKER_ID) {
    return undefined
  }
  return process.env.BELAY_JUDGE_MODEL_RESOLVED?.trim() || undefined
}

/** @deprecated Use resolveJudgeModel */
export const resolveCloudModel = (
  requested: string,
  _pinned: { autoResolved: string },
): { requested: string; resolved: string } => {
  rejectDeprecatedJudgeModelAuto(requested)
  const envResolved = testJudgeModelOverride()
  return {
    requested,
    resolved: envResolved || requested,
  }
}

/** @deprecated Use resolveJudgeModel */
export const resolveCursorModel = resolveCloudModel

function providerIdFromJudge(judge: BelayJudgeConfig): JudgeProviderId {
  if (judge.providerId) {
    const normalized = normalizeLegacyProviderId(judge.providerId)
    if (normalized) {
      return normalized
    }
  }
  return inferProviderIdFromConfig(judge)
}

function createCliJudgeForProvider(
  providerId: Exclude<JudgeProviderId, 'ollama'>,
  judgeConfig: BelayJudgeConfig,
  config: BelayConfigV4,
  repoRoot?: string,
): TracedTier1Judge {
  const resolvedRepoRoot = repoRoot ?? process.cwd()
  const { resolved } = resolveJudgeModel(judgeConfig)
  const options = {
    modelRequested: judgeConfig.model,
    modelResolved: resolved,
    timeoutMs: judgeConfig.timeoutMs,
    sensitivePaths: config.classifier.sensitivePaths,
    scrubOptions: scrubOptionsFromConfig(config),
    runtime: judgeConfig.runtime,
    repoRoot: resolvedRepoRoot,
    stateDir: belayStateDir(config, repoLocalStateDirFor(resolvedRepoRoot, config)),
    judgeMode: config.mode,
  }
  if (providerId === 'codex') {
    return createCodexCliJudge(options)
  }
  if (providerId === 'cursor') {
    return createCursorCliJudge(options)
  }
  return createClaudeCliJudge(options)
}

export function createJudgeFromConfig(
  config: BelayConfigV4,
  options: { pinnedModels?: { autoResolved: string }; repoRoot?: string } = {},
): TracedTier1Judge {
  if (process.env.BELAY_DETERMINISTIC_JUDGE === '1') {
    return createDeterministicJudgeStub()
  }

  const judgeConfig = config.judge
  if (judgeConfig.providerId && isRemovedProviderId(String(judgeConfig.providerId))) {
    const { resolved } = resolveJudgeModel(judgeConfig)
    return createFailClosedJudge({
      reason: 'judge_provider_removed',
      fallbackReason: 'provider_migration_required',
      modelRequested: judgeConfig.model,
      modelResolved: resolved,
    })
  }

  const provider = normalizeJudgeProvider(judgeConfig.provider)
  const providerId = providerIdFromJudge(judgeConfig)
  const catalogSpec = getJudgeProviderSpec(providerId)
  const { resolved } = resolveJudgeModel(judgeConfig)
  const runtime = detectJudgeRuntimeCapabilities(providerId)
  const repoRoot = options.repoRoot ?? process.cwd()

  if (provider === 'openai-compatible') {
    const endpoint = judgeConfig.endpoint?.trim()
    if (!endpoint && runtime.cliTransport) {
      if (providerId === 'codex' || providerId === 'cursor') {
        return createCliJudgeForProvider(providerId, judgeConfig, config, repoRoot)
      }
    }

    if (!endpoint) {
      return createFailClosedJudge({
        reason: 'openai_compatible_endpoint_missing',
        fallbackReason: 'missing_endpoint',
        modelRequested: judgeConfig.model,
        modelResolved: resolved,
      })
    }

    if (isCloudJudgeConfig(judgeConfig) && !hasValidCloudConsent(judgeConfig)) {
      return createFailClosedJudge({
        reason: 'openai_compatible_consent_missing',
        fallbackReason: 'cloud_consent_missing',
        modelRequested: judgeConfig.model,
        modelResolved: resolved,
      })
    }

    const repoLocalStateDir = repoLocalStateDirFor(repoRoot, config)

    return createOpenAiCompatibleJudge({
      endpoint,
      modelRequested: judgeConfig.model,
      modelResolved: resolved,
      timeoutMs: judgeConfig.timeoutMs,
      sensitivePaths: config.classifier.sensitivePaths,
      scrubOptions: scrubOptionsFromConfig(config),
      resolveApiKey: async () =>
        resolveJudgeCredential({
          judge: judgeConfig,
          catalogSpec: catalogSpec ?? undefined,
          repoRoot,
          repoLocalStateDir,
          config,
        }),
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

  if (provider === 'anthropic') {
    if (runtime.cliTransport) {
      return createClaudeCliJudge({
        modelRequested: judgeConfig.model,
        modelResolved: resolved,
        timeoutMs: judgeConfig.timeoutMs,
        sensitivePaths: config.classifier.sensitivePaths,
        scrubOptions: scrubOptionsFromConfig(config),
        runtime: judgeConfig.runtime,
        repoRoot,
        stateDir: belayStateDir(config, repoLocalStateDirFor(repoRoot, config)),
        judgeMode: config.mode,
      })
    }
    return createFailClosedJudge({
      reason: 'anthropic_not_implemented',
      fallbackReason: 'anthropic_runtime_unavailable',
      modelRequested: judgeConfig.model,
      modelResolved: resolved,
    })
  }

  return createFailClosedJudge({
    reason: 'unsupported_judge_provider',
    fallbackReason: 'unsupported_provider',
    modelRequested: judgeConfig.model,
    modelResolved: resolved,
  })
}

export function judgeConfigSummary(judge: BelayJudgeConfig): string {
  const id = judge.providerId ?? judge.provider
  return `${id}/${judge.model}`
}
