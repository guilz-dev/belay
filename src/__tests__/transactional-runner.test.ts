import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'

import { afterEach, describe, expect, it } from 'vitest'
import { classifyShell } from '../core/classify-shell.js'
import { DEFAULT_CONFIG_V3 } from '../core/config.js'
import {
  TRANSACTIONAL_ALREADY_APPLIED,
  TRANSACTIONAL_APPLY_FAILED,
} from '../core/transactional/reasons.js'
import { runTransactionalExecution } from '../core/transactional/runner.js'

const execFileAsync = promisify(execFile)
const tempDirs: string[] = []

async function createGitRepo(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'belay-tx-'))
  tempDirs.push(dir)
  await execFileAsync('git', ['init'], { cwd: dir })
  await execFileAsync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir })
  await execFileAsync('git', ['config', 'user.name', 'Test'], { cwd: dir })
  await writeFile(path.join(dir, 'README.md'), '# test\n')
  await execFileAsync('git', ['add', 'README.md'], { cwd: dir })
  await execFileAsync('git', ['commit', '-m', 'init'], { cwd: dir })
  return dir
}

describe('transactional runner', () => {
  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
  })

  it('observes safe mutations and commits them to the real repo', async () => {
    const repoRoot = await createGitRepo()
    const predicted = classifyShell('touch safe.txt', repoRoot, repoRoot, {
      unknownLocalEffect: 'allow_flagged',
    })
    const stateDir = path.join(repoRoot, '.cursor', 'belay', 'transactional')

    const result = await runTransactionalExecution({
      command: 'touch safe.txt',
      cwd: repoRoot,
      repoRoot,
      stateDir,
      timeoutMs: 10_000,
      predicted,
      diffContext: {
        repoRoot,
        sensitivePaths: DEFAULT_CONFIG_V3.classifier.sensitivePaths,
        protectedRoots: [],
        maxDeletionCount: 10,
      },
    })

    expect(result.ok).toBe(true)
    expect(result.observed?.verdict).toBe('allow')
    expect(result.result.verdict).toBe('allow')
    expect(result.result.reason).toBe(TRANSACTIONAL_ALREADY_APPLIED)
    await expect(readFile(path.join(repoRoot, 'safe.txt'), 'utf8')).resolves.toBeDefined()
  })

  it('discards dangerous mutations without applying them', async () => {
    const repoRoot = await createGitRepo()
    const predicted = classifyShell('rm -f README.md', repoRoot, repoRoot, {
      unknownLocalEffect: 'allow_flagged',
    })
    const stateDir = path.join(repoRoot, '.cursor', 'belay', 'transactional')

    const result = await runTransactionalExecution({
      command: 'rm -f README.md',
      cwd: repoRoot,
      repoRoot,
      stateDir,
      timeoutMs: 10_000,
      predicted,
      diffContext: {
        repoRoot,
        sensitivePaths: DEFAULT_CONFIG_V3.classifier.sensitivePaths,
        protectedRoots: [],
        maxDeletionCount: 0,
      },
    })

    expect(result.ok).toBe(true)
    expect(result.observed?.verdict).toBe('deny_pending_approval')
    expect(result.result.reason).toBe('transactional_observed_risk')
    await expect(readFile(path.join(repoRoot, 'README.md'), 'utf8')).resolves.toContain('# test')
  })

  it('skips transactional execution when tracked files are modified', async () => {
    const repoRoot = await createGitRepo()
    await writeFile(path.join(repoRoot, 'README.md'), '# dirty\n')
    const predicted = classifyShell('touch safe.txt', repoRoot, repoRoot, {
      unknownLocalEffect: 'allow_flagged',
    })
    const stateDir = path.join(repoRoot, '.cursor', 'belay', 'transactional')

    const result = await runTransactionalExecution({
      command: 'touch safe.txt',
      cwd: repoRoot,
      repoRoot,
      stateDir,
      timeoutMs: 10_000,
      predicted,
      diffContext: {
        repoRoot,
        sensitivePaths: DEFAULT_CONFIG_V3.classifier.sensitivePaths,
        protectedRoots: [],
        maxDeletionCount: 10,
      },
    })

    expect(result.skipped).toBe(true)
    expect(result.skipReason).toBe('dirty_worktree')
    await expect(readFile(path.join(repoRoot, 'safe.txt'), 'utf8')).rejects.toThrow()
  })

  it('denies when applying observed-safe changes fails', async () => {
    const repoRoot = await createGitRepo()
    await mkdir(path.join(repoRoot, 'safe.txt'))
    const predicted = classifyShell('touch safe.txt', repoRoot, repoRoot, {
      unknownLocalEffect: 'allow_flagged',
    })
    const stateDir = path.join(repoRoot, '.cursor', 'belay', 'transactional')

    const result = await runTransactionalExecution({
      command: 'touch safe.txt',
      cwd: repoRoot,
      repoRoot,
      stateDir,
      timeoutMs: 10_000,
      predicted,
      diffContext: {
        repoRoot,
        sensitivePaths: DEFAULT_CONFIG_V3.classifier.sensitivePaths,
        protectedRoots: [],
        maxDeletionCount: 10,
      },
    })

    expect(result.ok).toBe(true)
    expect(result.result.verdict).toBe('deny_pending_approval')
    expect(result.result.reason).toBe(TRANSACTIONAL_APPLY_FAILED)
  })

  it('falls back to prediction when the isolated command exits non-zero', async () => {
    const repoRoot = await createGitRepo()
    const predicted = classifyShell('false', repoRoot, repoRoot, {
      unknownLocalEffect: 'allow_flagged',
    })
    const stateDir = path.join(repoRoot, '.cursor', 'belay', 'transactional')

    const result = await runTransactionalExecution({
      command: 'false',
      cwd: repoRoot,
      repoRoot,
      stateDir,
      timeoutMs: 10_000,
      predicted,
      diffContext: {
        repoRoot,
        sensitivePaths: DEFAULT_CONFIG_V3.classifier.sensitivePaths,
        protectedRoots: [],
        maxDeletionCount: 10,
      },
    })

    expect(result.skipped).toBe(true)
    expect(result.skipReason).toBe('transactional_command_failed')
    expect(result.result).toEqual(predicted)
  })
})
