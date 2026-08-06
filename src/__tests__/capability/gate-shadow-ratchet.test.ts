import { mkdtemp } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import {
  evaluateShadowRatchetWarnings,
  recordGateApprovalAsk,
  recordPolicyJudgeComparison,
} from '../../core/capability/gate-shadow-ratchet.js'

describe('gate shadow ratchet', () => {
  it('warns on high policy/judge mismatch rate', async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), 'belay-ratchet-'))
    for (let index = 0; index < 10; index += 1) {
      await recordPolicyJudgeComparison('/repo', stateDir, index < 4)
    }
    const warnings = evaluateShadowRatchetWarnings({
      version: 1,
      policyJudgeComparisons: 10,
      policyJudgeMismatches: 4,
      approvalByReason: {},
      updatedAt: new Date().toISOString(),
    })
    expect(warnings.length).toBeGreaterThan(0)
  })

  it('warns on high approval rate for a reason', async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), 'belay-ratchet-'))
    for (let index = 0; index < 10; index += 1) {
      await recordGateApprovalAsk(stateDir, 'external_effect', index < 8)
    }
    const warnings = evaluateShadowRatchetWarnings({
      version: 1,
      policyJudgeComparisons: 0,
      policyJudgeMismatches: 0,
      approvalByReason: {
        external_effect: { asks: 10, approved: 8 },
      },
      updatedAt: new Date().toISOString(),
    })
    expect(warnings.some((warning) => warning.includes('external_effect'))).toBe(true)
  })

  it('counts approved replays without incrementing asks', async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), 'belay-ratchet-'))
    await recordGateApprovalAsk(stateDir, 'external_effect', false)
    await recordGateApprovalAsk(stateDir, 'external_effect', true)
    await recordGateApprovalAsk(stateDir, 'external_effect', true)
    const warnings = evaluateShadowRatchetWarnings({
      version: 1,
      policyJudgeComparisons: 0,
      policyJudgeMismatches: 0,
      approvalByReason: {
        external_effect: { asks: 1, approved: 2 },
      },
      updatedAt: new Date().toISOString(),
    })
    expect(warnings.some((warning) => warning.includes('external_effect'))).toBe(false)
  })
})
