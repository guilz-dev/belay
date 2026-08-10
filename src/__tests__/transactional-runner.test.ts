import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'

import { afterEach, describe, expect, it, vi } from 'vitest'
import { cursorAdapter } from '../adapters/cursor/adapter.js'
import { protectedArtifactRoots } from '../adapters/layouts/protected-paths.js'
import type { BoundaryAttestation, BoundaryDriverId } from '../core/capability/attestation.js'
import { hostIntegrationBoundaryContext } from '../core/capability/boundary-session.js'
import { DEFAULT_CONFIG_V3, DEFAULT_RECOVERY_CHECKPOINT } from '../core/config.js'
import { FILE_CHECKPOINT_ISOLATION_UNAVAILABLE } from '../core/transactional/backend-selector.js'
import * as gitWorktree from '../core/transactional/git-worktree.js'
import {
  TRANSACTIONAL_ALREADY_APPLIED,
  TRANSACTIONAL_APPLY_FAILED,
} from '../core/transactional/reasons.js'
import { runTransactionalExecution } from '../core/transactional/runner.js'
import { classifyShellCore } from './helpers/shell-classify.js'

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

function cursorDirtyIgnoreRoots(repoRoot: string): string[] {
  return protectedArtifactRoots(cursorAdapter.layout, repoRoot, null)
}

function containerIsolationAttestation(): BoundaryAttestation {
  return {
    version: 1,
    driver: 'container',
    probedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    deniesUngrantedEffects: true,
    materializesGrants: true,
    isolatesWorkspaceMounts: true,
    probeSignals: ['docker', 'workspace-mount-isolation'],
  }
}

function runnerParams(input: {
  command: string
  cwd: string
  repoRoot: string
  predicted: Awaited<ReturnType<typeof classifyShellCore>>
  stateDir: string
  maxDeletionCount?: number
  dirtyIgnoreRoots?: string[]
}) {
  return {
    command: input.command,
    cwd: input.cwd,
    repoRoot: input.repoRoot,
    stateDir: input.stateDir,
    timeoutMs: 10_000,
    predicted: input.predicted,
    fileCheckpoint: DEFAULT_CONFIG_V3.policy.transactional.fileCheckpoint,
    checkpoint: DEFAULT_CONFIG_V3.policy.transactional.checkpoint,
    diffContext: {
      repoRoot: input.repoRoot,
      sensitivePaths: DEFAULT_CONFIG_V3.classifier.sensitivePaths,
      protectedRoots: [],
      maxDeletionCount: input.maxDeletionCount ?? 10,
    },
    ...(input.dirtyIgnoreRoots ? { dirtyIgnoreRoots: input.dirtyIgnoreRoots } : {}),
  }
}

describe('transactional runner', () => {
  afterEach(async () => {
    vi.restoreAllMocks()
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
  })

  it('observes safe mutations and commits them to the real repo', async () => {
    const repoRoot = await createGitRepo()
    const predicted = await classifyShellCore('touch safe.txt', repoRoot, repoRoot, {
      unknownLocalEffect: 'allow_flagged',
    })
    const stateDir = path.join(repoRoot, '.cursor', 'belay', 'transactional')

    const result = await runTransactionalExecution(
      runnerParams({
        command: 'touch safe.txt',
        cwd: repoRoot,
        repoRoot,
        stateDir,
        predicted,
      }),
    )

    expect(result.ok).toBe(true)
    expect(result.observed?.verdict).toBe('allow')
    expect(result.result.verdict).toBe('allow')
    expect(result.result.reason).toBe(TRANSACTIONAL_ALREADY_APPLIED)
    await expect(readFile(path.join(repoRoot, 'safe.txt'), 'utf8')).resolves.toBeDefined()
  })

  it('discards dangerous mutations without applying them', async () => {
    const repoRoot = await createGitRepo()
    const predicted = await classifyShellCore('rm -f README.md', repoRoot, repoRoot, {
      unknownLocalEffect: 'allow_flagged',
    })
    const stateDir = path.join(repoRoot, '.cursor', 'belay', 'transactional')

    const result = await runTransactionalExecution(
      runnerParams({
        command: 'rm -f README.md',
        cwd: repoRoot,
        repoRoot,
        stateDir,
        predicted,
        maxDeletionCount: 0,
      }),
    )

    expect(result.ok).toBe(true)
    expect(result.observed?.verdict).toBe('deny_pending_approval')
    expect(result.result.reason).toBe('transactional_observed_risk')
    await expect(readFile(path.join(repoRoot, 'README.md'), 'utf8')).resolves.toContain('# test')
  })

  it('skips transactional execution when tracked files are modified', async () => {
    const repoRoot = await createGitRepo()
    await writeFile(path.join(repoRoot, 'README.md'), '# dirty\n')
    const predicted = await classifyShellCore('touch safe.txt', repoRoot, repoRoot, {
      unknownLocalEffect: 'allow_flagged',
    })
    const stateDir = path.join(repoRoot, '.cursor', 'belay', 'transactional')

    const result = await runTransactionalExecution(
      runnerParams({
        command: 'touch safe.txt',
        cwd: repoRoot,
        repoRoot,
        stateDir,
        predicted,
      }),
    )

    expect(result.skipped).toBe(true)
    expect(result.skipReason).toBe('dirty_worktree')
    await expect(readFile(path.join(repoRoot, 'safe.txt'), 'utf8')).rejects.toThrow()
  })

  it.each([
    ['missing or tampered', null, false, 'container' as const],
    ['stale', containerIsolationAttestation(), false, 'container' as const],
    ['driver-mismatched', containerIsolationAttestation(), true, 'host-integration' as const],
  ])('surfaces unavailable isolation for %s boundary attestation', async (_case, attestation, attestationFresh, driverId: BoundaryDriverId) => {
    const repoRoot = await createGitRepo()
    await writeFile(path.join(repoRoot, 'README.md'), '# dirty\n')
    const predicted = await classifyShellCore('touch safe.txt', repoRoot, repoRoot, {
      unknownLocalEffect: 'allow_flagged',
    })
    const stateDir = path.join(repoRoot, '.cursor', 'belay', 'transactional')
    const params = runnerParams({
      command: 'touch safe.txt',
      cwd: repoRoot,
      repoRoot,
      stateDir,
      predicted,
    })
    const boundaryContext = {
      ...hostIntegrationBoundaryContext(repoRoot),
      driverId,
      attestation,
      attestationFresh,
    }

    const result = await runTransactionalExecution({
      ...params,
      fileCheckpoint: { ...params.fileCheckpoint, enabled: true },
      checkpoint: {
        ...DEFAULT_RECOVERY_CHECKPOINT,
        enabled: true,
      },
      boundaryContext,
    })

    expect(result.skipped).toBe(true)
    expect(result.skipReason).toBe(FILE_CHECKPOINT_ISOLATION_UNAVAILABLE)
    await expect(readFile(path.join(repoRoot, 'safe.txt'), 'utf8')).rejects.toThrow()
  })

  it('denies when applying observed-safe changes fails', async () => {
    const repoRoot = await createGitRepo()
    const predicted = await classifyShellCore('touch safe.txt', repoRoot, repoRoot, {
      unknownLocalEffect: 'allow_flagged',
    })
    const stateDir = path.join(repoRoot, '.cursor', 'belay', 'transactional')
    vi.spyOn(gitWorktree, 'applyWorktreeChanges').mockRejectedValueOnce(new Error('apply failed'))

    const result = await runTransactionalExecution(
      runnerParams({
        command: 'touch safe.txt',
        cwd: repoRoot,
        repoRoot,
        stateDir,
        predicted,
      }),
    )

    expect(result.ok).toBe(true)
    expect(result.result.verdict).toBe('deny_pending_approval')
    expect(result.result.reason).toBe(TRANSACTIONAL_APPLY_FAILED)
  })

  it('flags rollback failure when apply cannot restore workspace state', async () => {
    const repoRoot = await createGitRepo()
    const predicted = await classifyShellCore('touch safe.txt', repoRoot, repoRoot, {
      unknownLocalEffect: 'allow_flagged',
    })
    const stateDir = path.join(repoRoot, '.cursor', 'belay', 'transactional')
    vi.spyOn(gitWorktree, 'applyWorktreeChanges').mockRejectedValueOnce(
      new Error('transactional_apply_rollback_failed'),
    )

    const result = await runTransactionalExecution(
      runnerParams({
        command: 'touch safe.txt',
        cwd: repoRoot,
        repoRoot,
        stateDir,
        predicted,
      }),
    )

    expect(result.ok).toBe(true)
    expect(result.result.verdict).toBe('deny_pending_approval')
    expect(result.result.assessment.signals).toContain('transactional_apply_rollback_failed')
  })

  it('falls back to prediction when the isolated command exits non-zero', async () => {
    const repoRoot = await createGitRepo()
    const predicted = await classifyShellCore('false', repoRoot, repoRoot, {
      unknownLocalEffect: 'allow_flagged',
    })
    const stateDir = path.join(repoRoot, '.cursor', 'belay', 'transactional')

    const result = await runTransactionalExecution(
      runnerParams({
        command: 'false',
        cwd: repoRoot,
        repoRoot,
        stateDir,
        predicted,
      }),
    )

    expect(result.skipped).toBe(true)
    expect(result.skipReason).toBe('transactional_command_failed')
    expect(result.result).toEqual(predicted)
  })

  it('ignores untracked belay init artifacts when dirtyIgnoreRoots is provided', async () => {
    const repoRoot = await createGitRepo()
    await mkdir(path.join(repoRoot, '.cursor', 'belay'), { recursive: true })
    await writeFile(path.join(repoRoot, '.cursor', 'belay', 'audit.ndjson'), '')
    await writeFile(path.join(repoRoot, '.cursor', 'belay.config.json'), '{}\n')
    const predicted = await classifyShellCore('touch safe.txt', repoRoot, repoRoot, {
      unknownLocalEffect: 'allow_flagged',
    })
    const stateDir = path.join(repoRoot, '.cursor', 'belay', 'transactional')

    const result = await runTransactionalExecution(
      runnerParams({
        command: 'touch safe.txt',
        cwd: repoRoot,
        repoRoot,
        stateDir,
        predicted,
        dirtyIgnoreRoots: cursorDirtyIgnoreRoots(repoRoot),
      }),
    )

    expect(result.ok).toBe(true)
    expect(result.result.reason).toBe(TRANSACTIONAL_ALREADY_APPLIED)
    await expect(readFile(path.join(repoRoot, 'safe.txt'), 'utf8')).resolves.toBeDefined()
  })
})
