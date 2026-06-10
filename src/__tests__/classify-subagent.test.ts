import { describe, expect, it } from 'vitest'

import { classifySubagent } from '../core/classify-subagent.js'

const repoRoot = '/workspace/project'

describe('classifySubagent', () => {
  it('denies deploy to production phrasing', () => {
    const result = classifySubagent(
      {
        tool_name: 'Task',
        tool_input: { description: 'deploy to production after tests pass' },
      },
      repoRoot,
    )
    expect(result.verdict).toBe('deny_pending_approval')
  })

  it('allows investigation tasks that mention production', () => {
    const result = classifySubagent(
      {
        tool_name: 'Task',
        tool_input: { description: 'investigate production bug in checkout flow' },
      },
      repoRoot,
    )
    expect(result.verdict).toBe('allow_flagged')
    expect(result.assessment.signals).toContain('external_term_investigation_context')
  })

  it('fingerprints description and prompt separately from noise', () => {
    const first = classifySubagent(
      {
        tool_name: 'Task',
        tool_input: { description: 'deploy to production after tests pass' },
      },
      repoRoot,
    )
    const second = classifySubagent(
      {
        tool_name: 'Task',
        tool_input: { description: 'deploy to production after smoke tests pass' },
      },
      repoRoot,
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
    )
    expect(result.verdict).toBe('allow_flagged')
  })
})
