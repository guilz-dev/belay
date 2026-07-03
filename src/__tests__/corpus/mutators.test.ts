import { describe, expect, it } from 'vitest'
import {
  ALL_STRUCTURAL_WRAPPERS,
  AUTO_LABEL_MUTATORS,
  CATASTROPHIC_CORES,
  generateMutatedCases,
  STRUCTURAL_PROBES,
} from '../../corpus/mutators.js'

describe('corpus mutators', () => {
  it('assigns unique ids across auto-label and structural probes', () => {
    const ids = [...AUTO_LABEL_MUTATORS, ...STRUCTURAL_PROBES].map((m) => m.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('keeps promotion candidates out of Phase A auto-label set', () => {
    const autoIds = new Set(AUTO_LABEL_MUTATORS.map((m) => m.id))
    for (const id of ['nohup', 'sudo', 'eval'] as const) {
      expect(autoIds.has(id)).toBe(false)
      expect(STRUCTURAL_PROBES.some((m) => m.id === id)).toBe(true)
    }
  })

  it('produces non-empty commands for every mutator and core', () => {
    for (const mutator of ALL_STRUCTURAL_WRAPPERS) {
      for (const core of CATASTROPHIC_CORES) {
        const command = mutator.apply(core)
        expect(command.trim().length).toBeGreaterThan(0)
      }
    }
  })

  it('generates cartesian product cases', () => {
    const cases = generateMutatedCases(['rm -rf .git'], AUTO_LABEL_MUTATORS)
    expect(cases).toHaveLength(AUTO_LABEL_MUTATORS.length)
    expect(cases.every((c) => c.core === 'rm -rf .git')).toBe(true)
  })

  it('ALL_STRUCTURAL_WRAPPERS includes both sets', () => {
    expect(ALL_STRUCTURAL_WRAPPERS.length).toBe(
      AUTO_LABEL_MUTATORS.length + STRUCTURAL_PROBES.length,
    )
  })
})
