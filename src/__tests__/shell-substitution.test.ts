import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { classifyShell } from '../core/classify-shell.js'
import { findCommandSubstitutions } from '../core/shell-substitution.js'

const repoRoot = '/workspace/project'
const cwd = path.join(repoRoot, 'src')

describe('findCommandSubstitutions', () => {
  it('finds nested and multiple substitutions', () => {
    expect(findCommandSubstitutions('$(echo $(git push))')).toEqual(['echo $(git push)'])
    expect(findCommandSubstitutions('echo $(git status) $(git push)')).toEqual([
      'git status',
      'git push',
    ])
  })

  it('ignores escaped substitutions', () => {
    expect(findCommandSubstitutions('echo \\$(git push)')).toEqual([])
  })
})

describe('classifyShell nested substitution', () => {
  it('denies nested command substitution', () => {
    const result = classifyShell('$(echo $(git push origin main))', cwd, repoRoot)
    expect(result.verdict).toBe('deny_pending_approval')
    expect(result.reason).toBe('command_substitution')
  })

  it('denies chained substitution segments', () => {
    const result = classifyShell('true && $(git push origin main)', cwd, repoRoot)
    expect(result.verdict).toBe('deny_pending_approval')
    expect(result.reason).toBe('command_substitution')
  })

  it('treats escaped substitution as read-only outer command', () => {
    const result = classifyShell('echo \\$(git push origin main)', cwd, repoRoot)
    expect(result.verdict).toBe('allow')
  })

  it('ignores substitution inside single quotes', () => {
    expect(findCommandSubstitutions("echo '$(git push origin main)'")).toEqual([])
    const result = classifyShell("echo '$(git push origin main)'", cwd, repoRoot)
    expect(result.verdict).toBe('allow')
  })

  it('still denies when outer command is external alongside benign substitution', () => {
    const result = classifyShell('git push origin main $(git status)', cwd, repoRoot)
    expect(result.verdict).toBe('deny_pending_approval')
    expect(result.reason).toBe('external_effect')
  })

  it('denies chained external commands even when later substitution is benign', () => {
    const result = classifyShell('git push origin main; echo $(git status)', cwd, repoRoot)
    expect(result.verdict).toBe('deny_pending_approval')
    expect(result.reason).toBe('external_effect')
  })
})
