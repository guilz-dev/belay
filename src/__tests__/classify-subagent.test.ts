import { describe, expect, it } from 'vitest'
import { classifySubagent } from '../core/classify-subagent.js'
import { mergeConfig } from '../core/config.js'

const repoRoot = '/workspace/project'
const config = mergeConfig({})

describe('classifySubagent', () => {
  it('flags deploy to production phrasing without denying the launch', () => {
    const result = classifySubagent(
      {
        tool_name: 'Task',
        tool_input: { description: 'deploy to production after tests pass' },
      },
      repoRoot,
      {},
      config,
    )
    expect(result.verdict).toBe('allow_flagged')
    expect(result.assessment.signals).toContain('subagent_external_intent_hint')
  })

  it('allows investigation tasks that mention production', () => {
    const result = classifySubagent(
      {
        tool_name: 'Task',
        tool_input: { description: 'investigate production bug in checkout flow' },
      },
      repoRoot,
      {},
      config,
    )
    expect(result.verdict).toBe('allow_flagged')
    expect(result.assessment.signals).toContain('subagent_external_intent_hint')
  })

  it('fingerprints description and prompt separately from noise', () => {
    const first = classifySubagent(
      {
        tool_name: 'Task',
        tool_input: { description: 'deploy to production after tests pass' },
      },
      repoRoot,
      {},
      config,
    )
    const second = classifySubagent(
      {
        tool_name: 'Task',
        tool_input: { description: 'deploy to production after smoke tests pass' },
      },
      repoRoot,
      {},
      config,
    )
    expect(first.fingerprint).not.toBe(second.fingerprint)
  })

  it('flags routine subagent tasks by default', () => {
    const result = classifySubagent(
      {
        subagent_type: 'generalPurpose',
        task: { description: 'search the codebase for auth middleware' },
      },
      repoRoot,
      {},
      config,
    )
    expect(result.verdict).toBe('allow_flagged')
    expect(result.capabilityRequests?.[0]?.action).toBe('process.exec')
    expect(result.authorizationDecision?.matchedRule).toBe('builtin.subagent')
  })
})
