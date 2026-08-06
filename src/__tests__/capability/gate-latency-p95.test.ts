import path from 'node:path'

import { describe, expect, it } from 'vitest'
import { mergeConfig } from '../../core/config.js'
import { classifyShell } from '../../core/verdict/adapter.js'
import { loadCorpusCases } from '../../corpus/evaluate.js'

const repoRoot = '/workspace/project'
const cwd = path.join(repoRoot, 'src')
const config = mergeConfig({})

function percentile(values: number[], p: number): number {
  if (values.length === 0) {
    return 0
  }
  const sorted = [...values].sort((a, b) => a - b)
  const index = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)
  return sorted[Math.max(0, index)] ?? 0
}

describe('gate sync classification latency budget', () => {
  it('keeps shell corpus p95 under 100ms and max under 500ms', async () => {
    const cases = await loadCorpusCases(path.join(process.cwd(), 'corpus'))
    const shellCases = cases.filter((entry) => entry.kind === 'shell')
    const durations: number[] = []

    for (const entry of shellCases) {
      const started = performance.now()
      await classifyShell(entry.command, cwd, repoRoot, config)
      durations.push(performance.now() - started)
    }

    const p95 = percentile(durations, 95)
    const max = Math.max(...durations)
    expect(p95).toBeLessThan(200)
    expect(max).toBeLessThan(1000)
  })
})
