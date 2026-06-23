import type { JudgeProviderId } from './judge-catalog.js'

export interface BelayJudgeSessionConfig {
  enabled: boolean
  maxTurns: number
  maxAgeMs: number
  maxIdleMs: number
  maxPromptBytes: number
  providerAllowlist: JudgeProviderId[]
  connectTimeoutMs: number
  evalTimeoutMs: number | null
  parseTimeoutMs: number
  maxSessionsPerProvider: number
}

export interface BelayJudgeShadowConfig {
  enabled: boolean
  sampleRate: number
  sampleRateMax: number
  dailyRequestCap: number
  mismatchRateThreshold: number
  providerAllowlist: JudgeProviderId[]
  windowSize: number
}

export interface BelayJudgeRuntimeConfig {
  session: BelayJudgeSessionConfig
  shadow: BelayJudgeShadowConfig
}

export const JUDGE_LATENCY_SLO = {
  /** Target: Tier1 p95 at least 40% below spawn baseline. */
  tier1P95ReductionTarget: 0.4,
  /** Reference spawn baseline (ms) from dogfood measurement. */
  spawnBaselineP95Ms: 25_000,
  spawnBaselineP50Ms: 1_300,
  tier0BaselineP95Ms: 60,
  /** Session path must not exceed spawn p95 when enabled. */
  sessionMaxP95Ms: 15_000,
} as const

export const DEFAULT_JUDGE_SESSION_CONFIG: BelayJudgeSessionConfig = {
  enabled: false,
  maxTurns: 32,
  maxAgeMs: 30 * 60 * 1000,
  maxIdleMs: 5 * 60 * 1000,
  maxPromptBytes: 64 * 1024,
  providerAllowlist: ['cursor'],
  connectTimeoutMs: 5_000,
  evalTimeoutMs: null,
  parseTimeoutMs: 2_000,
  maxSessionsPerProvider: 1,
}

export const DEFAULT_JUDGE_SHADOW_CONFIG: BelayJudgeShadowConfig = {
  enabled: false,
  sampleRate: 0.01,
  sampleRateMax: 0.05,
  dailyRequestCap: 500,
  mismatchRateThreshold: 0.02,
  providerAllowlist: ['cursor'],
  windowSize: 100,
}

export const DEFAULT_JUDGE_RUNTIME_CONFIG: BelayJudgeRuntimeConfig = {
  session: { ...DEFAULT_JUDGE_SESSION_CONFIG },
  shadow: { ...DEFAULT_JUDGE_SHADOW_CONFIG },
}

const CLI_PROVIDER_IDS: JudgeProviderId[] = ['codex', 'cursor', 'claude']

function normalizeProviderAllowlist(
  value: unknown,
  fallback: JudgeProviderId[],
): JudgeProviderId[] {
  if (!Array.isArray(value)) {
    return [...fallback]
  }
  const allowed = value
    .map((entry) => String(entry).trim())
    .filter((entry): entry is JudgeProviderId =>
      CLI_PROVIDER_IDS.includes(entry as JudgeProviderId),
    )
  return allowed.length > 0 ? [...new Set(allowed)] : [...fallback]
}

function normalizePositiveInt(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : fallback
}

function normalizeRate(value: unknown, fallback: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    return fallback
  }
  return Math.min(value, max)
}

export function normalizeJudgeRuntimeConfig(
  runtime: Partial<BelayJudgeRuntimeConfig> | undefined,
): BelayJudgeRuntimeConfig {
  const session: Partial<BelayJudgeSessionConfig> = runtime?.session ?? {}
  const shadow: Partial<BelayJudgeShadowConfig> = runtime?.shadow ?? {}
  return {
    session: normalizeJudgeSessionConfig(session),
    shadow: {
      enabled: shadow.enabled === true,
      sampleRate: normalizeRate(shadow.sampleRate, DEFAULT_JUDGE_SHADOW_CONFIG.sampleRate, 1),
      sampleRateMax: normalizeRate(
        shadow.sampleRateMax,
        DEFAULT_JUDGE_SHADOW_CONFIG.sampleRateMax,
        1,
      ),
      dailyRequestCap: normalizePositiveInt(
        shadow.dailyRequestCap,
        DEFAULT_JUDGE_SHADOW_CONFIG.dailyRequestCap,
      ),
      mismatchRateThreshold: normalizeRate(
        shadow.mismatchRateThreshold,
        DEFAULT_JUDGE_SHADOW_CONFIG.mismatchRateThreshold,
        1,
      ),
      providerAllowlist: normalizeProviderAllowlist(
        shadow.providerAllowlist,
        DEFAULT_JUDGE_SHADOW_CONFIG.providerAllowlist,
      ),
      windowSize: normalizePositiveInt(shadow.windowSize, DEFAULT_JUDGE_SHADOW_CONFIG.windowSize),
    },
  }
}

export function normalizeJudgeSessionConfig(
  session: Partial<BelayJudgeSessionConfig> | undefined,
): BelayJudgeSessionConfig {
  const input = session ?? {}
  return {
    enabled: input.enabled === true,
    maxTurns: normalizePositiveInt(input.maxTurns, DEFAULT_JUDGE_SESSION_CONFIG.maxTurns),
    maxAgeMs: normalizePositiveInt(input.maxAgeMs, DEFAULT_JUDGE_SESSION_CONFIG.maxAgeMs),
    maxIdleMs: normalizePositiveInt(input.maxIdleMs, DEFAULT_JUDGE_SESSION_CONFIG.maxIdleMs),
    maxPromptBytes: normalizePositiveInt(
      input.maxPromptBytes,
      DEFAULT_JUDGE_SESSION_CONFIG.maxPromptBytes,
    ),
    providerAllowlist: normalizeProviderAllowlist(
      input.providerAllowlist,
      DEFAULT_JUDGE_SESSION_CONFIG.providerAllowlist,
    ),
    connectTimeoutMs: normalizePositiveInt(
      input.connectTimeoutMs,
      DEFAULT_JUDGE_SESSION_CONFIG.connectTimeoutMs,
    ),
    evalTimeoutMs:
      typeof input.evalTimeoutMs === 'number' && input.evalTimeoutMs > 0
        ? Math.floor(input.evalTimeoutMs)
        : null,
    parseTimeoutMs: normalizePositiveInt(
      input.parseTimeoutMs,
      DEFAULT_JUDGE_SESSION_CONFIG.parseTimeoutMs,
    ),
    maxSessionsPerProvider: normalizePositiveInt(
      input.maxSessionsPerProvider,
      DEFAULT_JUDGE_SESSION_CONFIG.maxSessionsPerProvider,
    ),
  }
}

export function resolveSessionEvalTimeoutMs(
  sessionConfig: BelayJudgeSessionConfig,
  judgeTimeoutMs: number,
): number {
  return sessionConfig.evalTimeoutMs ?? judgeTimeoutMs
}
