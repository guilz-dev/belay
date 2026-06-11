import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

import { evaluateCorpus, loadCorpusCases } from '../corpus/evaluate.js'

const corpusDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'corpus')

describe('corpus evaluation', () => {
  it('meets baseline accuracy on shell command corpus', async () => {
    const cases = await loadCorpusCases(corpusDir)
    const metrics = evaluateCorpus(cases)
    expect(metrics.accuracy).toBeGreaterThanOrEqual(0.9)
    expect(metrics.falsePositiveRate).toBeLessThanOrEqual(0.1)
  })
})
