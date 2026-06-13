import type { BelayJudgeConfig } from './config.js'

export type JudgeProfileName = 'cursor-composer' | 'local-ollama'

export const JUDGE_PROFILE_CURSOR_COMPOSER: BelayJudgeConfig = {
  provider: 'cursor',
  model: 'auto',
  timeoutMs: 8000,
  endpoint: null,
  keepAlive: null,
}

export const JUDGE_PROFILE_LOCAL_OLLAMA: BelayJudgeConfig = {
  provider: 'ollama',
  model: 'gemma4:e2b',
  endpoint: 'http://localhost:11434',
  timeoutMs: 25000,
  keepAlive: '30m',
}

export const JUDGE_PROFILES: Record<JudgeProfileName, BelayJudgeConfig> = {
  'cursor-composer': JUDGE_PROFILE_CURSOR_COMPOSER,
  'local-ollama': JUDGE_PROFILE_LOCAL_OLLAMA,
}

export interface ResolveJudgeConfigInput {
  judgeProfile?: JudgeProfileName
  judgeProvider?: 'cursor' | 'ollama'
  judgeModel?: string
  existingJudge?: BelayJudgeConfig
}

export function resolveJudgeConfig(input: ResolveJudgeConfigInput = {}): BelayJudgeConfig {
  if (input.judgeProvider) {
    const base =
      input.judgeProvider === 'cursor' ? JUDGE_PROFILE_CURSOR_COMPOSER : JUDGE_PROFILE_LOCAL_OLLAMA
    return {
      ...base,
      model: input.judgeModel ?? base.model,
    }
  }

  if (input.judgeProfile) {
    const profile = JUDGE_PROFILES[input.judgeProfile]
    return {
      ...profile,
      model: input.judgeModel ?? profile.model,
    }
  }

  if (input.existingJudge) {
    return { ...input.existingJudge }
  }

  return { ...JUDGE_PROFILE_CURSOR_COMPOSER }
}

export class CloudJudgeConsentRequiredError extends Error {
  constructor() {
    super(
      'Cloud judge sends redacted shell commands outside the repo and requires CURSOR_API_KEY. ' +
        'Pass --accept-cloud-judge to confirm, or use --judge-profile local-ollama for local-only Tier1.',
    )
    this.name = 'CloudJudgeConsentRequiredError'
  }
}

function isCloudJudgeConfig(judge: BelayJudgeConfig): boolean {
  return judge.provider === 'cursor'
}

export function resolveInitJudgeConfig(input: {
  isFresh: boolean
  hasExplicitJudgeFlags: boolean
  judgeProfile?: JudgeProfileName
  judgeProvider?: 'cursor' | 'ollama'
  judgeModel?: string
  acceptCloudJudge?: boolean
  existingJudge?: BelayJudgeConfig
}): BelayJudgeConfig {
  if (input.hasExplicitJudgeFlags) {
    const judge = resolveJudgeConfig({
      judgeProfile: input.judgeProfile,
      judgeProvider: input.judgeProvider,
      judgeModel: input.judgeModel,
    })
    if (isCloudJudgeConfig(judge) && !input.acceptCloudJudge) {
      throw new CloudJudgeConsentRequiredError()
    }
    return judge
  }

  if (!input.isFresh && input.existingJudge) {
    return resolveJudgeConfig({ existingJudge: input.existingJudge })
  }

  if (input.isFresh) {
    if (input.acceptCloudJudge) {
      return resolveJudgeConfig({ judgeProfile: 'cursor-composer' })
    }
    return resolveJudgeConfig({ judgeProfile: 'local-ollama' })
  }

  return resolveJudgeConfig({ existingJudge: input.existingJudge })
}
