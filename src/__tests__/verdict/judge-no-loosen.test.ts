import { describe, expect, it } from 'vitest'
import { tier1RequiresAsk } from '../../core/verdict/judge.js'
import { verdict } from '../../core/verdict/verdict.js'
import { verdictTestContext } from './helpers.js'

describe('T13 no silent loosen on provider change', () => {
  it('tier1RequiresAsk treats destroys_history_or_secrets as ask', () => {
    expect(
      tier1RequiresAsk({
        local_recoverable: true,
        destroys_outside_repo: false,
        destroys_history_or_secrets: true,
        reason: 'authorized_keys',
      }),
    ).toBe(true)
  })

  it('requires approval for shell redirects outside repo (policy engine)', async () => {
    const context = verdictTestContext()
    const result = await verdict('echo hi > /tmp/belay-judge-no-loosen-outside.txt', context)
    expect(result.permission).toBe('ask')
    expect(result.reason).toBe('outside_repo_mutation')
    expect(result.authorizationDecision?.outcome).toBe('require_approval')
  })

  it('keeps high-stakes path ask with deterministic policy', async () => {
    const context = verdictTestContext()
    const result = await verdict('rm -rf .git', context)
    expect(result.permission).toBe('ask')
    expect(result.reason).toBe('control_plane_mutation')
  })

  it('requires approval for ambiguous external commands without sync judge', async () => {
    const context = verdictTestContext()
    const result = await verdict('aws s3 mb s3://new-bucket', context)
    expect(result.permission).toBe('ask')
  })
})
