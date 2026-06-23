import { describe, expect, it } from 'vitest'

import {
  judgeLatencyPercentiles,
  judgeLatencySloReport,
  recordJudgeLatency,
  resetJudgeLatencySamples,
} from '../../core/verdict/judge-baseline.js'
import { JUDGE_LATENCY_SLO } from '../../core/verdict/judge-runtime-config.js'

describe('judge-baseline', () => {
  it('records percentiles per phase', () => {
    resetJudgeLatencySamples()
    recordJudgeLatency('tier1_spawn', 20_000)
    recordJudgeLatency('tier1_spawn', 30_000)
    recordJudgeLatency('tier1_spawn', 25_000)

    const stats = judgeLatencyPercentiles('tier1_spawn')
    expect(stats.count).toBe(3)
    expect(stats.p50).toBe(25_000)
    expect(stats.p95).toBe(30_000)
  })

  it('reports SLO against baseline when no samples exist', () => {
    resetJudgeLatencySamples()
    const report = judgeLatencySloReport()
    expect(report.slo.tier1P95ReductionTarget).toBe(JUDGE_LATENCY_SLO.tier1P95ReductionTarget)
    expect(report.measured.tier1_spawn.count).toBe(0)
  })
})
