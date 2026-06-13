import path from 'node:path'

import { describe, expect, it } from 'vitest'
import { GUARANTEE_SCENARIOS, GUARANTEE_TABLE_ROWS } from '../../conformance/guarantee-table.js'
import type { LayerProfileId } from '../../conformance/types.js'
import { DEFAULT_CONFIG_V3 } from '../../core/config.js'
import { isTransactionalEligible } from '../../core/transactional/index.js'
import { classifyShellCore } from '../helpers/shell-classify.js'

const repoRoot = '/workspace/project'
const cwd = path.join(repoRoot, 'src')

describe('guarantee table conformance', () => {
  it('documents four configuration profiles', () => {
    expect(GUARANTEE_TABLE_ROWS).toHaveLength(4)
    expect(GUARANTEE_TABLE_ROWS.map((row) => row.profile)).toEqual([
      'l3-l4-only',
      'l1-partial-egress',
      'l1-l2-transactional',
      'l1-full',
    ])
  })

  it('assigns unique scenario ids per profile', () => {
    const ids = Object.values(GUARANTEE_SCENARIOS).flatMap((scenarios) =>
      scenarios.map((scenario) => scenario.id),
    )
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('keeps machine-readable scenarios aligned with the shell classifier', async () => {
    for (const scenarios of Object.values(GUARANTEE_SCENARIOS)) {
      for (const scenario of scenarios) {
        const result = await classifyShellCore(scenario.command, cwd, repoRoot)
        expect(result.verdict === 'deny_pending_approval' ? 'deny' : 'allow').toBe(
          scenario.permission,
        )
        if (scenario.reason) {
          expect(result.reason).toBe(scenario.reason)
        }
      }
    }
  })

  it('enables transactional eligibility under the transactional profile config', async () => {
    const config = {
      ...DEFAULT_CONFIG_V3,
      policy: {
        ...DEFAULT_CONFIG_V3.policy,
        unknownLocalEffect: 'allow_flagged' as const,
        transactional: { ...DEFAULT_CONFIG_V3.policy.transactional, enabled: true },
      },
    }
    const predicted = await classifyShellCore('touch notes.txt', repoRoot, repoRoot, {
      unknownLocalEffect: 'allow_flagged',
    })
    expect(isTransactionalEligible(config, 'shell', predicted)).toBe(true)
  })

  it('requires sandbox runtime for capability broker demotion', () => {
    const config = {
      ...DEFAULT_CONFIG_V3,
      sandbox: { ...DEFAULT_CONFIG_V3.sandbox, enabled: true, runtime: 'container' as const },
      egress: { ...DEFAULT_CONFIG_V3.egress, enabled: true, demoteL3External: true },
      approvalSigning: { required: true },
      controlPlane: {
        ...DEFAULT_CONFIG_V3.controlPlane,
        isolation: { mode: 'separate-user' as const, verifyAgentWritable: true },
      },
    }
    expect(config.sandbox.runtime).not.toBe('none')
    expect(config.approvalSigning.required).toBe(true)
    expect(config.controlPlane.isolation.mode).not.toBe('none')
  })

  for (const profile of Object.keys(GUARANTEE_SCENARIOS) as LayerProfileId[]) {
    it(`${profile} has at least two documented scenarios`, () => {
      expect(GUARANTEE_SCENARIOS[profile].length).toBeGreaterThanOrEqual(2)
    })
  }
})
