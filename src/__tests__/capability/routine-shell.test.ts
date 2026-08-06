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

  it('allow_flagged touch in repo', async () => {
    const result = await classifyShell('touch notes.txt', cwd, repoRoot, config)
    expect(result.verdict).toBe('allow_flagged')
  })
})
