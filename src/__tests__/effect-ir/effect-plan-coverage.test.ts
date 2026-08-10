import { describe, expect, it } from 'vitest'

import { DEFAULT_CONFIG_V3 } from '../../core/config.js'
import { collectRequirements, normalizeEffectTags } from '../../core/effect-ir/index.js'
import { classifyGatedAction, normalizeGatedAction } from '../../core/gate-engine.js'

describe('effect-plan coverage', () => {
  it('emits an explicit effect-free plan for a read-only shell action', async () => {
    const result = await classifyGatedAction(
      normalizeGatedAction({
        kind: 'shell',
        repoRoot: '/repo',
        cwd: '/repo',
        command: 'git status',
      }),
      DEFAULT_CONFIG_V3,
    )

    expect(result.effectPlan?.disposition).toBe('effect_free')
    expect(result.effectPlan?.completeness).toBe('complete')
  })

  it('emits a plan for an ordinary file-mutation tool action', async () => {
    const result = await classifyGatedAction(
      normalizeGatedAction({
        kind: 'tool',
        repoRoot: '/repo',
        cwd: '/repo',
        toolName: 'Write',
        payload: { tool_name: 'Write', tool_input: { file_path: '/repo/out.txt' } },
      }),
      DEFAULT_CONFIG_V3,
    )

    expect(result.effectPlan?.disposition).toBe('effects')
    if (!result.effectPlan) {
      throw new Error('expected effect plan')
    }
    expect(collectRequirements(result.effectPlan.root).map((entry) => entry.action)).toContain(
      'fs.write',
    )
  })

  it('emits a plan for a subagent action', async () => {
    const result = await classifyGatedAction(
      normalizeGatedAction({
        kind: 'subagent',
        repoRoot: '/repo',
        cwd: '/repo',
        payload: { task: { description: 'inspect authentication code' } },
      }),
      DEFAULT_CONFIG_V3,
    )

    expect(result.effectPlan?.disposition).toBe('effects')
    if (!result.effectPlan) {
      throw new Error('expected effect plan')
    }
    expect(collectRequirements(result.effectPlan.root).map((entry) => entry.action)).toContain(
      'process.exec',
    )
  })

  it('retains known effects alongside indeterminate uncertainty', () => {
    expect(normalizeEffectTags(['fs.write', 'indeterminate'])).toEqual([
      'fs.write',
      'indeterminate',
    ])
  })
})
