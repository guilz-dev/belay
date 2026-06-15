import { accessSync, constants } from 'node:fs'
import path from 'node:path'
import type { BelayJudgeConfig } from './config.js'
import type { Tier1JudgeTransport } from './verdict/judge.js'
import {
  inferProviderIdFromConfig,
  type JudgeProviderId,
  normalizeLegacyProviderId,
} from './verdict/judge-catalog.js'

export interface JudgeRuntimeCapabilities {
  http: boolean
  cliTransport: Tier1JudgeTransport | null
}

const CLI_COMMANDS: Record<Exclude<JudgeProviderId, 'ollama'>, string> = {
  codex: 'codex',
  cursor: 'cursor-agent',
  claude: 'claude',
}

function isVitestRuntime(env: NodeJS.ProcessEnv): boolean {
  return Boolean(env.VITEST || env.VITEST_WORKER_ID)
}

function cliTransportForProvider(providerId: JudgeProviderId): Tier1JudgeTransport | null {
  if (providerId === 'ollama') {
    return null
  }
  return `${providerId}-cli` as Tier1JudgeTransport
}

function commandOnPath(command: string, env: NodeJS.ProcessEnv): boolean {
  const pathValue = env.PATH ?? ''
  for (const dir of pathValue.split(path.delimiter).filter(Boolean)) {
    const candidate = path.join(dir, command)
    try {
      accessSync(candidate, constants.X_OK)
      return true
    } catch {
      // try next PATH entry
    }
  }
  return false
}

function providerIdFromJudge(
  judge: Pick<BelayJudgeConfig, 'providerId' | 'provider' | 'model' | 'endpoint'>,
): JudgeProviderId {
  if (judge.providerId && normalizeLegacyProviderId(judge.providerId)) {
    return normalizeLegacyProviderId(judge.providerId)!
  }
  return inferProviderIdFromConfig(judge)
}

export function detectJudgeRuntimeCapabilities(
  providerId: JudgeProviderId | string,
  env: NodeJS.ProcessEnv = process.env,
): JudgeRuntimeCapabilities {
  const normalized = normalizeLegacyProviderId(String(providerId))
  if (!normalized || normalized === 'ollama') {
    return { http: false, cliTransport: null }
  }

  if (env.BELAY_JUDGE_DISABLE_CLI_TRANSPORT === '1') {
    return { http: true, cliTransport: null }
  }

  if (isVitestRuntime(env)) {
    return { http: false, cliTransport: cliTransportForProvider(normalized) }
  }

  const command = CLI_COMMANDS[normalized]
  if (commandOnPath(command, env)) {
    return { http: false, cliTransport: cliTransportForProvider(normalized) }
  }

  return { http: true, cliTransport: null }
}

export function resolveJudgeTransport(
  judge: Pick<BelayJudgeConfig, 'providerId' | 'provider' | 'model' | 'endpoint'>,
  env: NodeJS.ProcessEnv = process.env,
): Tier1JudgeTransport {
  const providerId = providerIdFromJudge(judge)

  if (providerId === 'ollama') {
    return 'ollama-http'
  }

  if (judge.endpoint?.trim()) {
    return 'http'
  }

  const caps = detectJudgeRuntimeCapabilities(providerId, env)
  if (caps.cliTransport) {
    return caps.cliTransport
  }

  return 'unavailable'
}
