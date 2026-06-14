import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { findCommandSubstitutions } from '../core/shell-substitution.js'
import { classifyShellCore } from './helpers/shell-classify.js'

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
  it('denies nested command substitution', async () => {
    const result = await classifyShellCore('$(echo $(git push origin main))', cwd, repoRoot)
    expect(result.verdict).toBe('deny_pending_approval')
    expect(result.reason).toBe('command_substitution')
  })

  it('denies chained substitution segments', async () => {
    const result = await classifyShellCore('true && $(git push origin main)', cwd, repoRoot)
    expect(result.verdict).toBe('deny_pending_approval')
    expect(result.reason).toBe('command_substitution')
  })

  it('does not extract escaped substitution text for prescan', () => {
    expect(findCommandSubstitutions('echo \\$(git push origin main)')).toEqual([])
  })

  it('fails closed on quoted substitution syntax under v2', async () => {
    expect(findCommandSubstitutions("echo '$(git push origin main)'")).toEqual([])
    const result = await classifyShellCore("echo '$(git push origin main)'", cwd, repoRoot)
    expect(result.verdict).toBe('deny_pending_approval')
    expect(result.reason).toBe('command_substitution')
  })

  it('still denies when outer command is external alongside benign substitution', async () => {
    const result = await classifyShellCore('git push origin main $(git status)', cwd, repoRoot)
    expect(result.verdict).toBe('deny_pending_approval')
    expect(['command_substitution', 'external_effect']).toContain(result.reason)
  })

  it('denies chained external commands even when later substitution is benign', async () => {
    const result = await classifyShellCore(
      'git push origin main; echo $(git status)',
      cwd,
      repoRoot,
    )
    expect(result.verdict).toBe('deny_pending_approval')
    expect(['external_effect', 'command_substitution']).toContain(result.reason)
  })
})
