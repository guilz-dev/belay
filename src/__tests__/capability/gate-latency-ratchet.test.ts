import { mkdir, mkdtemp } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { evaluateGateLatencyRatchetAdvisories } from '../../core/capability/gate-latency-ratchet.js'
import { GATE_LATENCY_BUDGET, GATE_LATENCY_PLAN_TARGET } from '../../corpus/gate-latency-budget.js'
import { sandboxStatus } from '../../services/sandbox-service.js'

describe('gate latency ratchet', () => {
  it('warns when CI budgets exceed PLAN acceptance targets', () => {
    const warnings = evaluateGateLatencyRatchetAdvisories()
    expect(warnings.length).toBeGreaterThan(0)
    expect(warnings.some((warning) => warning.includes('quality-loop ratchet'))).toBe(true)
  })

  it('documents Step 3 thresholds as max(measured × 1.2, Step 1 floor)', () => {
    expect(GATE_LATENCY_BUDGET.shell.p95Ms).toBeGreaterThan(GATE_LATENCY_PLAN_TARGET.p95Ms)
    expect(GATE_LATENCY_BUDGET.shell.maxMs).toBeGreaterThan(GATE_LATENCY_PLAN_TARGET.maxMs)
  })

  it('surfaces latency ratchet as sandbox advisories, not issues', async () => {
    const repoRoot = await mkdtemp(path.join(os.tmpdir(), 'belay-sandbox-advisory-'))
    await mkdir(path.join(repoRoot, '.cursor'), { recursive: true })

    const report = await sandboxStatus({ targetDir: repoRoot })
    for (const advisory of evaluateGateLatencyRatchetAdvisories()) {
      expect(report.advisories).toContain(advisory)
      expect(report.issues).not.toContain(advisory)
    }
  })
})
