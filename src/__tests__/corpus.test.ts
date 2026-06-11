import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

import { assessmentsDiverge, evaluateCorpus, loadCorpusCases } from '../corpus/evaluate.js'

const corpusDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'corpus')

describe('corpus evaluation', () => {
  it('detects prediction vs observation assessment divergence', () => {
    expect(
      assessmentsDiverge(
        {
          reversibility: 'reversible',
          external: false,
          blastRadius: 'single file',
          confidence: 0.72,
          signals: [],
        },
        {
          reversibility: 'irreversible',
          external: false,
          blastRadius: 'directory tree',
          confidence: 1,
          signals: ['transactional_observed'],
        },
      ),
    ).toBe(true)
  })

  it('meets baseline accuracy on shell command corpus', async () => {
    const cases = await loadCorpusCases(corpusDir)
    const metrics = evaluateCorpus(cases)
    expect(metrics.accuracy).toBeGreaterThanOrEqual(0.9)
    expect(metrics.falsePositiveRate).toBeLessThanOrEqual(0.1)
  })
})
