import path from 'node:path'

import { describe, expect, it } from 'vitest'
import { GUARANTEE_SCENARIOS, GUARANTEE_TABLE_ROWS } from '../../conformance/guarantee-table.js'
import { layerProfileConfig } from '../../conformance/layer-profiles.js'
import type { LayerProfileId } from '../../conformance/types.js'
import { classifyShell } from '../../core/classify-shell.js'
import { isTransactionalEligible } from '../../core/transactional/index.js'

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

  it('demotes L3 external rules only when egress proxy demotion is active', () => {
    const demoted = classifyShell('git push origin main', cwd, repoRoot, {
      demoteL3External: true,
      unknownLocalEffect: 'allow_flagged',
    })
    expect(demoted.verdict).toBe('allow_flagged')
    expect(demoted.reason).toBe('l3_external_hint')

    const denied = classifyShell('git push origin main', cwd, repoRoot, {
      demoteL3External: false,
      unknownLocalEffect: 'allow_flagged',
    })
    expect(denied.verdict).toBe('deny_pending_approval')
    expect(denied.reason).toBe('external_effect')
  })

  it('enables transactional eligibility under the L2 profile config', () => {
    const config = layerProfileConfig('l1-l2-transactional')
    const predicted = classifyShell('touch notes.txt', repoRoot, repoRoot, {
      unknownLocalEffect: 'allow_flagged',
    })
    expect(isTransactionalEligible(config, 'shell', predicted)).toBe(true)
  })

  it('requires sandbox runtime for capability broker demotion', () => {
    const config = layerProfileConfig('l1-full')
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
