/**
 * Measure gate sync classification latency for ratchet baseline updates.
 * Run after build: pnpm build && node scripts/measure-gate-latency.mjs
 * Copy results into GATE_LATENCY_MEASURED_BASELINE in src/corpus/gate-latency-budget.ts
 * then lower GATE_LATENCY_STEP1_FLOOR when CI stays green.
 */
import path from 'node:path'

import { classifySubagent } from '../dist/core/classify-subagent.js'
import { classifyToolUse } from '../dist/core/classify-tool.js'
import { mergeConfig } from '../dist/core/config.js'
import { classifyShell } from '../dist/core/verdict/adapter.js'
import { loadCorpusCases } from '../dist/corpus/evaluate.js'

const repoRoot = '/workspace/project'
const cwd = path.join(repoRoot, 'src')
const config = mergeConfig({})

function percentile(values, p) {
  const sorted = [...values].sort((a, b) => a - b)
  const index = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)
  return sorted[Math.max(0, index)] ?? 0
}

function ceilMs(value) {
  return Math.ceil(value)
}

const cases = await loadCorpusCases(path.join(process.cwd(), 'corpus'))
const shellCases = cases.filter((entry) => entry.kind === 'shell')
const durations = []
await classifyShell('echo warmup', cwd, repoRoot, config)
for (const entry of shellCases) {
  const started = performance.now()
  await classifyShell(entry.command, cwd, repoRoot, config)
  durations.push(performance.now() - started)
}
const shell = {
  p95Ms: ceilMs(percentile(durations, 95)),
  maxMs: ceilMs(Math.max(...durations)),
}

const toolDurations = []
for (let i = 0; i < 5; i += 1) {
  const started = performance.now()
  await classifyToolUse(
    { tool_name: 'Write', tool_input: { path: 'notes.txt', contents: 'x' } },
    repoRoot,
    cwd,
    config,
  )
  toolDurations.push(performance.now() - started)
}
const tool = {
  p95Ms: ceilMs(percentile(toolDurations, 95)),
  maxMs: ceilMs(Math.max(...toolDurations)),
}

const subagentDurations = []
for (let i = 0; i < 5; i += 1) {
  const started = performance.now()
  classifySubagent(
    { tool_name: 'Task', tool_input: { description: 'search auth' } },
    repoRoot,
    {},
    config,
  )
  subagentDurations.push(performance.now() - started)
}
const subagent = {
  p95Ms: ceilMs(percentile(subagentDurations, 95)),
  maxMs: ceilMs(Math.max(...subagentDurations)),
}

console.log(JSON.stringify({ shell, tool, subagent }, null, 2))
