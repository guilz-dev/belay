import type { BelayJudgeConfig, JudgeCredentialConfig } from './config.js'
import { belayStateDir } from './config.js'
import { parseCredentialRef, readJudgeCredentialStore } from './credential-store.js'
import { detectJudgeRuntimeCapabilities } from './judge-runtime-detection.js'
import {
  getJudgeProviderSpec,
  inferProviderIdFromConfig,
  type JudgeProviderSpec,
  normalizeLegacyProviderId,
} from './verdict/judge-catalog.js'

export type JudgeCredentialSourceKind = 'env' | 'store' | 'host-session' | 'missing'

export interface ResolvedJudgeCredential {
  key: string | null
  source: string | null
  sourceKind: JudgeCredentialSourceKind
  mode: 'project' | 'apiKey'
}

/** @deprecated Use resolveJudgeCredential */
export function resolveJudgeApiKey(env: NodeJS.ProcessEnv = process.env): {
  key: string | null
  source: 'BELAY_JUDGE_API_KEY' | 'OPENAI_API_KEY' | null
} {
  const belay = env.BELAY_JUDGE_API_KEY?.trim()
  if (belay) {
    return { key: belay, source: 'BELAY_JUDGE_API_KEY' }
  }
  const openai = env.OPENAI_API_KEY?.trim()
  if (openai) {
    return { key: openai, source: 'OPENAI_API_KEY' }
  }
  return { key: null, source: null }
}

function resolveFromEnvChain(
  env: NodeJS.ProcessEnv,
  catalogSpec?: JudgeProviderSpec,
): { key: string | null; source: string | null } {
  const belay = env.BELAY_JUDGE_API_KEY?.trim()
  if (belay) {
    return { key: belay, source: 'BELAY_JUDGE_API_KEY' }
  }
  for (const name of catalogSpec?.apiKeyEnvVars ?? ['OPENAI_API_KEY', 'BELAY_JUDGE_API_KEY']) {
    const value = env[name]?.trim()
    if (value) {
      return { key: value, source: name }
    }
  }
  return { key: null, source: null }
}

function sourceKindForProjectMode(
  fromEnv: { key: string | null; source: string | null },
  judge: BelayJudgeConfig,
  catalogSpec?: JudgeProviderSpec,
): JudgeCredentialSourceKind {
  if (fromEnv.key) {
    return 'env'
  }
  const providerId =
    judge.providerId && normalizeLegacyProviderId(judge.providerId)
      ? normalizeLegacyProviderId(judge.providerId)!
      : inferProviderIdFromConfig(judge)
  const spec = catalogSpec ?? getJudgeProviderSpec(providerId)
  if (spec?.isCloud && detectJudgeRuntimeCapabilities(providerId).cliTransport) {
    return 'host-session'
  }
  return 'missing'
}

function sourceKindForApiKeyMode(
  key: string | null,
  source: string | null,
): JudgeCredentialSourceKind {
  if (!key) {
    return 'missing'
  }
  if (source?.startsWith('env:')) {
    return 'env'
  }
  return 'store'
}

export async function resolveJudgeCredential(params: {
  judge: BelayJudgeConfig
  catalogSpec?: JudgeProviderSpec
  repoRoot: string
  repoLocalStateDir: string
  config: Parameters<typeof belayStateDir>[0]
  env?: NodeJS.ProcessEnv
}): Promise<ResolvedJudgeCredential> {
  const env = params.env ?? process.env
  const credential: JudgeCredentialConfig = params.judge.credential ?? { mode: 'project' }

  if (credential.mode === 'apiKey') {
    const ref = credential.ref ? parseCredentialRef(credential.ref) : 'store:judge'
    if (ref === 'store:judge') {
      const stateDir = belayStateDir(params.config, params.repoLocalStateDir)
      const key = await readJudgeCredentialStore(stateDir)
      return {
        key,
        source: key ? `${stateDir}/credentials.json` : null,
        sourceKind: sourceKindForApiKeyMode(key, key ? `${stateDir}/credentials.json` : null),
        mode: 'apiKey',
      }
    }
    if (ref?.startsWith('env:')) {
      const envName = ref.slice(4)
      const value = env[envName]?.trim() ?? null
      return {
        key: value,
        source: value ? `env:${envName}` : null,
        sourceKind: sourceKindForApiKeyMode(value, value ? `env:${envName}` : null),
        mode: 'apiKey',
      }
    }
    return { key: null, source: null, sourceKind: 'missing', mode: 'apiKey' }
  }

  const fromEnv = resolveFromEnvChain(env, params.catalogSpec)
  return {
    ...fromEnv,
    sourceKind: sourceKindForProjectMode(fromEnv, params.judge, params.catalogSpec),
    mode: 'project',
  }
}
