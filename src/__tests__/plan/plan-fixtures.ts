/** Target constants from judge_default_and_config_ux plan (not yet fully implemented). */

export const PLAN_JUDGE_PROVIDER_IDS = ['ollama', 'codex', 'claude', 'cursor'] as const

export type PlanJudgeProviderId = (typeof PLAN_JUDGE_PROVIDER_IDS)[number]

export const PLAN_DEFAULT_MODELS: Record<PlanJudgeProviderId, string> = {
  ollama: 'gemma4:e2b',
  codex: 'gpt-5.3-codex-high',
  claude: 'claude-sonnet-4-6',
  cursor: 'composer-2.5',
}

export const PLAN_HOST_DEFAULT_PROVIDER: Record<'cursor' | 'claude' | 'codex', PlanJudgeProviderId> =
  {
    cursor: 'cursor',
    claude: 'claude',
    codex: 'codex',
  }

export const PLAN_PROVIDER_ADAPTERS: Record<PlanJudgeProviderId, string> = {
  ollama: 'ollama',
  codex: 'openai-compatible',
  claude: 'anthropic',
  cursor: 'openai-compatible',
}

export const PLAN_REMOVED_PROVIDER_IDS = ['openrouter', 'custom'] as const

export const PLAN_LEGACY_READ_ALIASES: Record<string, PlanJudgeProviderId> = {
  local: 'ollama',
  openai: 'codex',
}

/** Plan terminology (docs/CLI; JSON field names unchanged in v1). */
export const PLAN_TERMINOLOGY = {
  provider: '社名・サービス名 (judge.providerId)',
  adapter: 'API 互換層 (judge.provider)',
  host: '導入先 (config.adapter)',
} as const

export const PLAN_BELAY_CONFIG_SUBCOMMANDS = [
  'list',
  'get',
  'set',
  'unset',
  'credential',
  'judge',
] as const

export const PLAN_MODEL_DISCOVERY_SOURCES: Record<PlanJudgeProviderId, string> = {
  ollama: 'ollama-tags',
  codex: 'codex-cli',
  claude: 'anthropic-models',
  cursor: 'cursor-agent',
}

export const PLAN_CLI_TRANSPORTS = ['http', 'codex-cli', 'cursor-cli', 'claude-cli'] as const

export type PlanCliTransport = (typeof PLAN_CLI_TRANSPORTS)[number]
