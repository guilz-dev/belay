import { describe, expect, it } from 'vitest'

import { verdict } from '../../core/verdict/verdict.js'
import { verdictTestContext } from './helpers.js'

describe('belay judge self-command gate', () => {
  const context = verdictTestContext()

  it.each([
    'belay judge status',
    'belay judge use local',
    'belay judge use openai',
    'belay judge list',
    'belay judge test',
    'belay judge consent openai',
  ])('allows %s without approval', async (command) => {
    const result = await verdict(command, context)
    expect(result.permission).toBe('allow')
    expect(result.reason).toBe('belay_control_plane_command')
  })

  it('does not treat unrelated belay commands as judge self-commands', async () => {
    const result = await verdict('belay doctor', context)
    expect(result.reason).not.toBe('belay_control_plane_command')
  })
})
