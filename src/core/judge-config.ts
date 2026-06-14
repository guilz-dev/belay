import type { BelayJudgeConfig } from './config.js'
import { normalizeJudgeProvider } from './config.js'

export type JudgeProfileName = 'local-ollama' | 'cursor' | 'claude' | 'codex'

export const JUDGE_PROFILE_LOCAL_OLLAMA: BelayJudgeConfig = {
  provider: 'ollama',
  model: 'gemma4:e2b',
  endpoint: 'http://localhost:11434',
  timeoutMs: 25000,
  keepAlive: '30m',
}

export const JUDGE_PROFILE_CURSOR: BelayJudgeConfig = {
  provider: 'openai-compatible',
  model: 'auto',
  endpoint: 'https://api.openai.com/v1',
  timeoutMs: 8000,
  keepAlive: null,
}

export const JUDGE_PROFILE_CLAUDE: BelayJudgeConfig = {
  ...JUDGE_PROFILE_CURSOR,
}

export const JUDGE_PROFILE_CODEX: BelayJudgeConfig = {
  ...JUDGE_PROFILE_CURSOR,
}

export const JUDGE_PROFILES: Record<JudgeProfileName, BelayJudgeConfig> = {
  'local-ollama': JUDGE_PROFILE_LOCAL_OLLAMA,
  cursor: JUDGE_PROFILE_CURSOR,
  claude: JUDGE_PROFILE_CLAUDE,
  codex: JUDGE_PROFILE_CODEX,
}

export interface ResolveJudgeConfigInput {
  judgeProfile?: JudgeProfileName
  judgeProvider?: 'ollama' | 'openai-compatible' | 'cursor'
  judgeModel?: string
  judgeEndpoint?: string
  existingJudge?: BelayJudgeConfig
}

export function resolveJudgeConfig(input: ResolveJudgeConfigInput = {}): BelayJudgeConfig {
  if (input.judgeProvider) {
    const provider = normalizeJudgeProvider(input.judgeProvider)
    const base =
      provider === 'openai-compatible' ? openAiCompatibleBase(input) : JUDGE_PROFILE_LOCAL_OLLAMA
    return {
      ...base,
      model: input.judgeModel ?? base.model,
      endpoint: input.judgeEndpoint?.trim() || base.endpoint,
    }
  }

  if (input.judgeProfile) {
    const profile = JUDGE_PROFILES[input.judgeProfile]
    return {
      ...profile,
      model: input.judgeModel ?? profile.model,
      endpoint: input.judgeEndpoint?.trim() || profile.endpoint,
    }
  }

  if (input.existingJudge) {
    return { ...input.existingJudge }
  }

  return { ...JUDGE_PROFILE_LOCAL_OLLAMA }
}

function openAiCompatibleBase(input: ResolveJudgeConfigInput): BelayJudgeConfig {
  return {
    provider: 'openai-compatible',
    model: input.judgeModel ?? 'auto',
    timeoutMs: 8000,
    endpoint: input.judgeEndpoint?.trim() ?? null,
    keepAlive: null,
  }
}

export class CloudJudgeConsentRequiredError extends Error {
  constructor() {
    super(
      'Cloud judge sends redacted shell commands to an external endpoint and requires an API key in BELAY_JUDGE_API_KEY or OPENAI_API_KEY. ' +
        'Pass --accept-cloud-judge to confirm, or use --judge-profile local-ollama for local-only Tier1.',
    )
    this.name = 'CloudJudgeConsentRequiredError'
  }
}

export class JudgeEndpointRequiredError extends Error {
  constructor() {
    super(
      'openai-compatible judge requires --judge-endpoint (or judge.endpoint in config). No default cloud base URL is applied.',
    )
    this.name = 'JudgeEndpointRequiredError'
  }
}

function isCloudJudgeConfig(judge: BelayJudgeConfig): boolean {
  return judge.provider === 'openai-compatible'
}

export function assertJudgeEndpoint(judge: BelayJudgeConfig): void {
  if (judge.provider === 'openai-compatible' && !judge.endpoint?.trim()) {
    throw new JudgeEndpointRequiredError()
  }
}

export function resolveInitJudgeConfig(input: {
  isFresh: boolean
  hasExplicitJudgeFlags: boolean
  judgeProfile?: JudgeProfileName
  judgeProvider?: 'ollama' | 'openai-compatible' | 'cursor'
  judgeModel?: string
  judgeEndpoint?: string
  acceptCloudJudge?: boolean
  existingJudge?: BelayJudgeConfig
  defaultJudgeProfile?: JudgeProfileName
}): BelayJudgeConfig {
  if (input.hasExplicitJudgeFlags) {
    const judge = resolveJudgeConfig({
      judgeProfile: input.judgeProfile,
      judgeProvider: input.judgeProvider,
      judgeModel: input.judgeModel,
      judgeEndpoint: input.judgeEndpoint,
    })
    if (isCloudJudgeConfig(judge) && !input.acceptCloudJudge) {
      throw new CloudJudgeConsentRequiredError()
    }
    assertJudgeEndpoint(judge)
    return judge
  }

  if (!input.isFresh && input.existingJudge) {
    const judge = resolveJudgeConfig({ existingJudge: input.existingJudge })
    assertJudgeEndpoint(judge)
    return judge
  }

  return resolveJudgeConfig({ judgeProfile: input.defaultJudgeProfile ?? 'cursor' })
}
