import { JUDGE_LATENCY_SLO } from './judge-runtime-config.js'

export type JudgeLatencyPhase =
  | 'tier0'
  | 'tier1_spawn'
  | 'tier1_session'
  | 'tier1_connect'
  | 'tier1_eval'
  | 'tier1_parse'

export interface JudgeLatencySample {
  phase: JudgeLatencyPhase
  latencyMs: number
  at: number
}

export interface JudgeLatencyPercentiles {
  p50: number
  p95: number
  count: number
}

const samples: JudgeLatencySample[] = []
const MAX_SAMPLES = 2_000

export function resetJudgeLatencySamples(): void {
  samples.length = 0
}

export function recordJudgeLatency(
  phase: JudgeLatencyPhase,
  latencyMs: number,
  at = Date.now(),
): void {
  if (!Number.isFinite(latencyMs) || latencyMs < 0) {
    return
  }
  samples.push({ phase, latencyMs, at })
  if (samples.length > MAX_SAMPLES) {
    samples.splice(0, samples.length - MAX_SAMPLES)
  }
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) {
    return 0
  }
  const sorted = [...values].sort((a, b) => a - b)
  const index = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)
  return sorted[Math.max(0, index)] ?? 0
}

export function judgeLatencyPercentiles(phase: JudgeLatencyPhase): JudgeLatencyPercentiles {
  const values = samples
    .filter((sample) => sample.phase === phase)
    .map((sample) => sample.latencyMs)
  return {
    p50: percentile(values, 50),
    p95: percentile(values, 95),
    count: values.length,
  }
}

export function judgeLatencySloReport(): {
  slo: typeof JUDGE_LATENCY_SLO
  measured: Record<JudgeLatencyPhase, JudgeLatencyPercentiles>
  sessionMeetsTarget: boolean
} {
  const measured = {
    tier0: judgeLatencyPercentiles('tier0'),
    tier1_spawn: judgeLatencyPercentiles('tier1_spawn'),
    tier1_session: judgeLatencyPercentiles('tier1_session'),
    tier1_connect: judgeLatencyPercentiles('tier1_connect'),
    tier1_eval: judgeLatencyPercentiles('tier1_eval'),
    tier1_parse: judgeLatencyPercentiles('tier1_parse'),
  }

  const spawnP95 =
    measured.tier1_spawn.count > 0 ? measured.tier1_spawn.p95 : JUDGE_LATENCY_SLO.spawnBaselineP95Ms
  const sessionP95 = measured.tier1_session.count > 0 ? measured.tier1_session.p95 : spawnP95
  const targetP95 = spawnP95 * (1 - JUDGE_LATENCY_SLO.tier1P95ReductionTarget)
  const sessionMeetsTarget =
    sessionP95 <= targetP95 && sessionP95 <= JUDGE_LATENCY_SLO.sessionMaxP95Ms

  return { slo: JUDGE_LATENCY_SLO, measured, sessionMeetsTarget }
}
