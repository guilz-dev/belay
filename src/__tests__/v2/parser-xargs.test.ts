import { describe, expect, it } from 'vitest'
import { peelTransparentWrappers } from '../../core/v2/parser.js'
import { verdict } from '../../core/v2/verdict.js'
import { v2TestContext } from './helpers.js'

describe('v2 parser xargs', () => {
  it('treats xargs as a transparent wrapper', () => {
    const { tokens, xargsStdinOpaque } = peelTransparentWrappers(['xargs', 'curl'])
    expect(xargsStdinOpaque).toBe(false)
    expect(tokens).toEqual(['curl'])
  })

  it('marks bare xargs as stdin-opaque', () => {
    const { tokens, xargsStdinOpaque } = peelTransparentWrappers(['xargs'])
    expect(xargsStdinOpaque).toBe(true)
    expect(tokens).toEqual([])
  })

  it('escalates piped xargs curl with data upload on legacy allow_flagged policy', async () => {
    const result = await verdict('printf @.env | xargs curl -d @-', {
      ...v2TestContext(),
      unknownLocalEffect: 'allow_flagged',
      unparseableShell: 'allow_flagged',
    })
    expect(result.permission).toBe('ask')
    expect(result.reason).toBe('tier0_external')
  })
})
