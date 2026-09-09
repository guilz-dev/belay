import { describe, expect, it } from 'vitest'
import { collectRequirements } from '../../core/effect-ir/index.js'
import { peelTransparentWrappers } from '../../core/verdict/parser.js'
import { verdict } from '../../core/verdict/verdict.js'
import { verdictTestContext } from './helpers.js'

describe('parser xargs', () => {
  it('treats xargs as a transparent wrapper', () => {
    const { tokens, xargsStdinOpaque, encounteredXargs } = peelTransparentWrappers([
      'xargs',
      'curl',
    ])
    expect(xargsStdinOpaque).toBe(false)
    expect(encounteredXargs).toBe(true)
    expect(tokens).toEqual(['curl'])
  })

  it('marks bare xargs as stdin-opaque', () => {
    const { tokens, xargsStdinOpaque } = peelTransparentWrappers(['xargs'])
    expect(xargsStdinOpaque).toBe(true)
    expect(tokens).toEqual([])
  })

  it('does not drop xargs options without proving their operand grammar', () => {
    const peeled = peelTransparentWrappers(['xargs', '-n', '1', 'curl'])

    expect(peeled.opaque).toBe(true)
  })

  it('peels the xargs replacement option after consuming its operand', () => {
    const peeled = peelTransparentWrappers(['xargs', '-I{}', 'curl'])

    expect(peeled).toMatchObject({ tokens: ['curl'], opaque: false, encounteredXargs: true })
  })

  it('escalates piped xargs curl with data upload on legacy allow_flagged policy', async () => {
    const result = await verdict('printf @.env | xargs curl -d @-', {
      ...verdictTestContext(),
      unknownLocalEffect: 'allow_flagged',
      unparseableShell: 'allow_flagged',
    })
    expect(result.permission).toBe('ask')
    expect(result.reason).toBe('unknown_local_effect')
  })
})

describe('argv delegates in read-only compositions', () => {
  const context = verdictTestContext()

  it('preserves a quoted search pattern while lowering a read-only pipeline', async () => {
    const result = await verdict(
      'cat hooks.json | fictional-runner rg -n "beforeShellExecution|preToolUse"',
      context,
    )

    expect(result).toMatchObject({ permission: 'allow', reason: 'read_only' })
    expect(result.effectPlan?.completeness).toBe('complete')
  })

  it('keeps an opaque interpreter payload approval-required in a read-only pipeline', async () => {
    const result = await verdict('cat x | fictional-runner node -e "mutate()"', context)

    expect(result.permission).toBe('ask')
    expect(result.effectPlan?.completeness).toBe('partial')
    if (!result.effectPlan) {
      throw new Error('expected an EffectPlan for the delegated pipeline')
    }
    expect(collectRequirements(result.effectPlan.root)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          action: 'process.exec',
          resource: {
            kind: 'executable',
            command: 'fictional-runner',
            operation: 'spawn',
          },
        }),
        expect.objectContaining({
          action: 'indeterminate',
          evidence: expect.objectContaining({
            signals: expect.arrayContaining(['process.grammar_unknown']),
          }),
        }),
      ]),
    )
  })
})
