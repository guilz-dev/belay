import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { mergeConfig } from '../../core/config.js'
import { classifyShell } from '../../core/verdict/adapter.js'

const repoRoot = '/workspace/project'
const cwd = path.join(repoRoot, 'src')
const config = mergeConfig({})

describe('routine repo shell classification', () => {
  it('allows git status in repo', async () => {
    const result = await classifyShell('git status', cwd, repoRoot, config)
    expect(result.verdict).toBe('allow')
    expect(result.reason).toBe('read_only')
  })

  it.each([
    'git branch',
    'git branch -a',
    'git branch -v',
    'git branch --show-current',
    "git branch --list 'feature/*'",
    'git branch --contains HEAD',
  ])('allows read-only branch inspection: %s', async (command) => {
    const result = await classifyShell(command, cwd, repoRoot, config)
    expect(result.verdict).toBe('allow')
    expect(result.reason).toBe('read_only')
    expect(result.assessment.reversibility).toBe('reversible')
  })

  it.each([
    'git branch feature/foo',
    'git branch -d feature/foo',
    'git branch -D feature/foo',
    'git branch -m old-name new-name',
    'git branch --set-upstream-to=origin/main feature/foo',
  ])('allows recoverable local branch mutation with a flag: %s', async (command) => {
    const result = await classifyShell(command, cwd, repoRoot, config)
    expect(result.verdict).toBe('allow_flagged')
    expect(result.reason).toBe('local_mutation')
    expect(result.assessment.reversibility).toBe('recoverable_with_cost')
  })

  it('allow_flagged touch in repo', async () => {
    const result = await classifyShell('touch notes.txt', cwd, repoRoot, config)
    expect(result.verdict).toBe('allow_flagged')
  })
})
