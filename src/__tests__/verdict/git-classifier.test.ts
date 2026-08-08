import path from 'node:path'

import { describe, expect, it } from 'vitest'

import {
  classifyGitCommand,
  isGitReadOnlyInvocation,
  normalizeGitInvocation,
} from '../../core/verdict/git-classifier.js'

const cwd = path.join('/workspace/project', 'src')

describe('git-classifier', () => {
  it('normalizes git -C global options before subcommand detection', () => {
    const normalized = normalizeGitInvocation(['git', '-C', '/workspace/project', 'status'], cwd)
    expect(normalized?.subcommand).toBe('status')
    expect(normalized?.effectiveCwd).toBe('/workspace/project')
  })

  it('classifies git show-ref and reflog as read-only', () => {
    expect(classifyGitCommand(['git', 'show-ref', '--heads'], cwd)?.effect).toBe('read_only')
    expect(classifyGitCommand(['git', 'reflog', '-5'], cwd)?.effect).toBe('read_only')
  })

  it('does not treat branch names as file path targets', () => {
    const semantics = classifyGitCommand(['git', 'branch', 'feature/credentials'], cwd)
    expect(semantics?.pathTargets).toEqual([])
    expect(semantics?.effect).toBe('local_mutation')
  })

  it('does not treat commit messages as file path targets', () => {
    const semantics = classifyGitCommand(['git', 'commit', '-m', 'fix credentials leak'], cwd)
    expect(semantics?.pathTargets).toEqual([])
  })

  it('requires approval for hard reset and non-dry-run clean', () => {
    expect(classifyGitCommand(['git', 'reset', '--hard'], cwd)?.requiresAsk?.reason).toBe(
      'git_history_destructive',
    )
    expect(classifyGitCommand(['git', 'clean', '-fdx'], cwd)?.requiresAsk?.reason).toBe(
      'git_history_destructive',
    )
  })

  it('allows soft reset and dry-run clean without requiresAsk', () => {
    expect(classifyGitCommand(['git', 'reset', '--soft'], cwd)?.requiresAsk).toBeUndefined()
    expect(classifyGitCommand(['git', 'clean', '-n'], cwd)?.effect).toBe('read_only')
  })

  it('does not mark git stash push as git.push', () => {
    const semantics = classifyGitCommand(['git', 'stash', 'push', '-m', 'wip'], cwd)
    expect(semantics?.signals).not.toContain('git.push')
    expect(semantics?.effect).toBe('local_mutation')
  })

  it('marks git push with git.push signal', () => {
    const semantics = classifyGitCommand(['git', 'push', 'origin', 'main'], cwd)
    expect(semantics?.signals).toContain('git.push')
    expect(semantics?.effect).toBe('remote_mutation')
  })

  it('treats git fetch and pull as remote mutations', () => {
    const fetch = classifyGitCommand(['git', 'fetch', 'origin'], cwd)
    expect(fetch?.effect).toBe('remote_mutation')
    expect(fetch?.egressClass).toBe('ambiguous')
    expect(fetch?.signals).toContain('git.remote')

    const pull = classifyGitCommand(['git', 'pull', 'origin', 'main'], cwd)
    expect(pull?.effect).toBe('remote_mutation')
    expect(pull?.egressClass).toBe('ambiguous')
  })

  it('does not treat git reset -h as hard reset', () => {
    expect(classifyGitCommand(['git', 'reset', '-h'], cwd)?.requiresAsk).toBeUndefined()
    expect(classifyGitCommand(['git', 'reset', '--hard'], cwd)?.requiresAsk?.reason).toBe(
      'git_history_destructive',
    )
  })

  it('treats checkout refs as local mutations without file path targets', () => {
    const semantics = classifyGitCommand(['git', 'checkout', 'feature/credentials'], cwd)
    expect(semantics?.pathTargets).toEqual([])
    expect(semantics?.effect).toBe('local_mutation')
    expect(semantics?.isReadOnly).toBe(false)
  })

  it('does not treat show/log/diff ref names as file path targets', () => {
    expect(classifyGitCommand(['git', 'show', 'feature/credentials'], cwd)?.pathTargets).toEqual([])
    expect(classifyGitCommand(['git', 'log', 'feature/credentials'], cwd)?.pathTargets).toEqual([])
    expect(classifyGitCommand(['git', 'diff', 'feature/credentials'], cwd)?.pathTargets).toEqual([])
    expect(classifyGitCommand(['git', 'diff', 'src/foo.ts'], cwd)?.pathTargets).toEqual([
      'src/foo.ts',
    ])
  })

  it('keeps checkout file operands after --', () => {
    const semantics = classifyGitCommand(['git', 'checkout', '--', 'src/foo.ts'], cwd)
    expect(semantics?.pathTargets).toEqual(['src/foo.ts'])
    expect(semantics?.effect).toBe('local_mutation')
  })

  it('resolves git --work-tree for path operand analysis', () => {
    const semantics = classifyGitCommand(
      ['git', '--work-tree=/workspace/other', 'add', 'src/foo.ts'],
      cwd,
    )
    expect(semantics?.gitWorkTree).toBe('/workspace/other')
    expect(semantics?.pathTargets).toEqual(['src/foo.ts'])
    expect(semantics?.scopeTargets).toContain('/workspace/other')
  })

  it('keeps explicit git execution roots as scope targets', () => {
    expect(
      classifyGitCommand(['git', '-C', '/workspace/other', 'branch', 'feature/x'], cwd)
        ?.scopeTargets,
    ).toContain('/workspace/other')
    expect(
      classifyGitCommand(['git', '--git-dir=/workspace/other.git', 'branch', 'feature/x'], cwd)
        ?.scopeTargets,
    ).toContain('/workspace/other.git')
  })

  it('detects read-only branch listing via helper', () => {
    expect(isGitReadOnlyInvocation(['git', 'branch', '-a'], cwd)).toBe(true)
    expect(isGitReadOnlyInvocation(['git', 'branch', 'feature/foo'], cwd)).toBe(false)
  })
})
