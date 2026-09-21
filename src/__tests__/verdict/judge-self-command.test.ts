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
    'belay config',
    'belay config list',
    'belay config get judge.model',
    'belay config set judge.providerId cursor',
    'belay config unset judge.endpoint',
    'belay config credential mode project',
  ])('allows %s without approval', async (command) => {
    const result = await verdict(command, context)
    expect(result.permission).toBe('allow')
    expect(result.reason).toBe('belay_control_plane_command')
  })

  it('does not treat unrelated belay commands as judge self-commands', async () => {
    const result = await verdict('belay doctor', context)
    expect(result.reason).not.toBe('belay_control_plane_command')
  })

  it('does not allow belay config set on non-judge paths', async () => {
    const result = await verdict('belay config set gates.mode enforce', context)
    expect(result.permission).not.toBe('allow')
  })

  it('requires human approval for the complete token-mint and self-approval sequence', async () => {
    for (const command of [
      'belay approval-token belay_pending',
      'belay approve belay_pending --token signed.token',
    ]) {
      const result = await verdict(command, context)
      expect(result.permission, command).toBe('ask')
      expect(result.reason, command).toBe('control_plane_mutation')
    }
  })

  it('requires human approval before trusting repository config', async () => {
    const result = await verdict('belay config trust', context)
    expect(result.permission).toBe('ask')
    expect(result.reason).toBe('control_plane_mutation')
  })

  it.each([
    'belay manifest trust demo --rule r1',
    'belay manifest revoke demo --rule r1',
    'belay manifest --json trust demo --rule r1',
    'belay manifest --target /tmp trust demo --rule r1',
    'belay manifest --cwd infer trust /absolute/tool --rule r1',
    'belay manifest --json revoke demo --rule r1',
  ])('requires human approval for effect-manifest authority mutation: %s', async (command) => {
    const result = await verdict(command, context)
    expect(result.permission).toBe('ask')
    expect(result.reason).toBe('control_plane_mutation')
  })

  it.each([
    'belay manifest show trust',
    'belay manifest validate revoke',
    'belay manifest infer -- tool trust',
    'belay manifest --cwd trust show revoke',
  ])('does not mistake manifest operands for authority mutations: %s', async (command) => {
    const result = await verdict(command, context)
    expect(result.permission).toBe('allow')
    expect(result.reason).not.toBe('control_plane_mutation')
  })
})
