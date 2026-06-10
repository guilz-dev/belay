import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { classifyShell } from '../core/classify-shell.js'
import { classifyToolUse } from '../core/classify-tool.js'

const repoRoot = '/workspace/project'
const cwd = repoRoot

describe('classifyToolUse', () => {
  it('reuses shell classification and fingerprint for Shell tool', () => {
    const shellOnly = classifyToolUse(
      { tool_name: 'Shell', tool_input: { command: 'git push origin main' } },
      repoRoot,
      cwd,
    )
    expect(shellOnly.verdict).toBe('deny_pending_approval')
    expect(shellOnly.summary).toBe('git push origin main')

    const shellHook = classifyShell('git push origin main', cwd, repoRoot)
    expect(shellOnly.fingerprint).toBe(shellHook.fingerprint)
  })

  it('denies writes outside the repository', () => {
    const result = classifyToolUse(
      { tool_name: 'Write', tool_input: { path: '/tmp/outside.txt', contents: 'x' } },
      repoRoot,
      cwd,
    )
    expect(result.verdict).toBe('deny_pending_approval')
    expect(result.reason).toBe('outside_repo_file_mutation')
  })

  it('denies sensitive path mutations', () => {
    const result = classifyToolUse(
      { tool_name: 'Write', tool_input: { path: '.env', contents: 'SECRET=1' } },
      repoRoot,
      cwd,
    )
    expect(result.verdict).toBe('deny_pending_approval')
    expect(result.reason).toBe('sensitive_file_mutation')
  })

  it('flags routine in-repo file writes', () => {
    const filePath = path.join(repoRoot, 'notes.txt')
    const result = classifyToolUse(
      { tool_name: 'Write', tool_input: { path: filePath, contents: 'hello' } },
      repoRoot,
      cwd,
    )
    expect(result.verdict).toBe('allow_flagged')
  })
})
