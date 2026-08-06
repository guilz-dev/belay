import { describe, expect, it, vi } from 'vitest'

import { mergeConfig } from '../../core/config.js'
import { classifyGatedAction, normalizeGatedAction } from '../../core/gate-engine.js'
import * as judgeFactory from '../../core/verdict/judge-factory.js'

const repoRoot = '/workspace/project'
const cwd = `${repoRoot}/src`

describe('gate sync path does not invoke Tier1 judge', () => {
  it('never calls createJudgeFromConfig during shell classification', async () => {
    const createSpy = vi.spyOn(judgeFactory, 'createJudgeFromConfig')
    const config = mergeConfig({})
    const action = normalizeGatedAction({
      kind: 'shell',
      repoRoot,
      cwd,
      command: 'git status',
    })
    await classifyGatedAction(action, config)
    expect(createSpy).not.toHaveBeenCalled()
    createSpy.mockRestore()
  })

  it('never calls createJudgeFromConfig for network shell commands', async () => {
    const createSpy = vi.spyOn(judgeFactory, 'createJudgeFromConfig')
    const config = mergeConfig({})
    const action = normalizeGatedAction({
      kind: 'shell',
      repoRoot,
      cwd,
      command: 'curl https://example.com',
    })
    await classifyGatedAction(action, config)
    expect(createSpy).not.toHaveBeenCalled()
    createSpy.mockRestore()
  })

  it('never calls createJudgeFromConfig for tool classification', async () => {
    const createSpy = vi.spyOn(judgeFactory, 'createJudgeFromConfig')
    const config = mergeConfig({})
    const action = normalizeGatedAction({
      kind: 'tool',
      repoRoot,
      cwd,
      payload: {
        tool_name: 'Write',
        tool_input: { path: 'notes.txt', contents: 'hello' },
      },
    })
    await classifyGatedAction(action, config)
    expect(createSpy).not.toHaveBeenCalled()
    createSpy.mockRestore()
  })

  it('never calls createJudgeFromConfig for subagent classification', async () => {
    const createSpy = vi.spyOn(judgeFactory, 'createJudgeFromConfig')
    const config = mergeConfig({})
    const action = normalizeGatedAction({
      kind: 'subagent',
      repoRoot,
      cwd,
      payload: {
        tool_name: 'Task',
        tool_input: { description: 'search the codebase' },
      },
    })
    await classifyGatedAction(action, config)
    expect(createSpy).not.toHaveBeenCalled()
    createSpy.mockRestore()
  })
})
