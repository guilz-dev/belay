import path from 'node:path'

import { describe, expect, it } from 'vitest'
import { classifySubagent } from '../../core/classify-subagent.js'
import { classifyToolUse } from '../../core/classify-tool.js'
import { mergeConfig } from '../../core/config.js'
import { classifyShell } from '../../core/verdict/adapter.js'
import { loadCorpusCases } from '../../corpus/evaluate.js'
import { GATE_LATENCY_BUDGET } from '../../corpus/gate-latency-budget.js'

const repoRoot = '/workspace/project'
const cwd = path.join(repoRoot, 'src')
const config = mergeConfig({})
const NON_SHELL_LATENCY_SAMPLE_COUNT = 20

function percentile(values: number[], p: number): number {
  if (values.length === 0) {
    return 0
  }
  const sorted = [...values].sort((a, b) => a - b)
  const index = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)
  return sorted[Math.max(0, index)] ?? 0
}

async function measureShellLatency(): Promise<{ p95: number; max: number }> {
  const cases = await loadCorpusCases(path.join(process.cwd(), 'corpus'))
  const shellCases = cases.filter((entry) => entry.kind === 'shell')
  const durations: number[] = []

  await classifyShell('echo warmup', cwd, repoRoot, config)
  for (const entry of shellCases) {
    const started = performance.now()
    await classifyShell(entry.command, cwd, repoRoot, config)
    durations.push(performance.now() - started)
  }

  return { p95: percentile(durations, 95), max: Math.max(...durations) }
}

describe('gate sync classification latency budget', () => {
  it('keeps shell corpus within measured baseline budget', async () => {
    const { p95, max } = await measureShellLatency()
    expect(p95).toBeLessThan(GATE_LATENCY_BUDGET.shell.p95Ms)
    expect(max).toBeLessThan(GATE_LATENCY_BUDGET.shell.maxMs)
  })

  it('keeps tool and subagent classification within baseline budget', async () => {
    await classifyShell('echo warmup', cwd, repoRoot, config)

    const toolDurations: number[] = []
    for (let i = 0; i < NON_SHELL_LATENCY_SAMPLE_COUNT; i += 1) {
      const started = performance.now()
      await classifyToolUse(
        {
          tool_name: 'Write',
          tool_input: { path: 'notes.txt', contents: 'latency probe' },
        },
        repoRoot,
        cwd,
        config,
      )
      toolDurations.push(performance.now() - started)
    }

    const subagentDurations: number[] = []
    for (let i = 0; i < NON_SHELL_LATENCY_SAMPLE_COUNT; i += 1) {
      const started = performance.now()
      classifySubagent(
        {
          tool_name: 'Task',
          tool_input: { description: 'search auth middleware' },
        },
        repoRoot,
        {},
        config,
      )
      subagentDurations.push(performance.now() - started)
    }

    expect(percentile(toolDurations, 95)).toBeLessThan(GATE_LATENCY_BUDGET.tool.p95Ms)
    expect(Math.max(...toolDurations)).toBeLessThan(GATE_LATENCY_BUDGET.tool.maxMs)
    expect(percentile(subagentDurations, 95)).toBeLessThan(GATE_LATENCY_BUDGET.subagent.p95Ms)
    expect(Math.max(...subagentDurations)).toBeLessThan(GATE_LATENCY_BUDGET.subagent.maxMs)
  })
})
