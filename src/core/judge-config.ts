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
