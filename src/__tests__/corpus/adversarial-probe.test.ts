import { describe, expect, it } from 'vitest'
import {
  createSeededRandom,
  generateFpProbeCases,
  generateProbeCases,
  holdoutFixFnRateRatio,
  runAdversarialProbe,
  shuffleWithSeed,
  splitFixHoldout,
} from '../../corpus/adversarial-probe.js'
import { AUTO_LABEL_MUTATORS, CATASTROPHIC_CORES } from '../../corpus/mutators.js'

describe('adversarial probe', () => {
  it('generates deterministic case count from cores × auto-label mutators', () => {
    const cases = generateProbeCases(42)
    expect(cases).toHaveLength(CATASTROPHIC_CORES.length * AUTO_LABEL_MUTATORS.length)
  })

  it('respects maxCases cap after seed shuffle', () => {
    const full = generateProbeCases(99)
    const capped = generateProbeCases(99, 5)
    expect(capped).toHaveLength(5)
    expect(capped).toEqual(full.slice(0, 5))
  })

  it('shuffles deterministically with seed', () => {
    const items = ['a', 'b', 'c', 'd', 'e']
    expect(shuffleWithSeed(items, 99)).toEqual(shuffleWithSeed(items, 99))
    expect(shuffleWithSeed(items, 99)).not.toEqual(shuffleWithSeed(items, 100))
  })

  it('splits fix and holdout with at least one holdout when possible', () => {
    const items = Array.from({ length: 10 }, (_, i) => i)
    const { fix, holdout } = splitFixHoldout(items, 7, 0.2)
    expect(fix.length + holdout.length).toBe(10)
    expect(holdout.length).toBeGreaterThanOrEqual(1)
  })

  it('createSeededRandom produces values in [0, 1)', () => {
    const random = createSeededRandom(1)
    for (let i = 0; i < 20; i += 1) {
      const value = random()
      expect(value).toBeGreaterThanOrEqual(0)
      expect(value).toBeLessThan(1)
    }
  })

  it('holdoutFixFnRateRatio is 1 when both fix and holdout FN rates are 0', () => {
    expect(holdoutFixFnRateRatio(0, 0)).toBe(1)
    expect(holdoutFixFnRateRatio(0.1, 0.1)).toBeCloseTo(1)
    expect(holdoutFixFnRateRatio(0, 0.1)).toBeNull()
    expect(holdoutFixFnRateRatio(0.1, null)).toBeNull()
  })

  it('generates FP probe cases from must-allow cores', () => {
    const cases = generateFpProbeCases(42)
    expect(cases.length).toBeGreaterThan(0)
    expect(cases.every((c) => c.core === 'pnpm test' || c.mutatorId)).toBe(true)
  })

  it('reports zero FN on current classifier for auto-label mutations', async () => {
    const report = await runAdversarialProbe({ seed: 42 })
    expect(report.failures).toHaveLength(0)
    expect(report.firstPassFnRate).toBe(0)
    expect(report.holdoutFnRate).toBe(0)
    expect(report.holdoutFixFnRateRatio).toBe(1)
    expect(report.fixSetFnRate).toBe(0)
    expect(report.passedCases.length).toBe(report.totalCases)
    expect(report.holdoutRatio).toBe(0.2)
    expect(report.fpProbeSize).toBeGreaterThan(0)
    expect(report.firstPassFpRate).not.toBeNull()
  })

  it('sets holdoutFnRate to null when holdout set is empty', async () => {
    const report = await runAdversarialProbe({ seed: 42, maxCases: 1 })
    expect(report.totalCases).toBe(1)
    expect(report.holdoutSetSize).toBe(0)
    expect(report.holdoutFnRate).toBeNull()
    expect(report.holdoutFixFnRateRatio).toBeNull()
  })
})
