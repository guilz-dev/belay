import { execFile } from 'node:child_process'
import { chmod, lstat, mkdtemp, readFile, readlink, rm, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'

import { afterEach, describe, expect, it, vi } from 'vitest'
import { cursorAdapter } from '../adapters/cursor/adapter.js'
import { protectedArtifactRoots } from '../adapters/layouts/protected-paths.js'
import type { BoundaryAttestation } from '../core/capability/attestation.js'
import { DEFAULT_CONFIG_V3 } from '../core/config.js'
import { fileCheckpointBackend } from '../core/transactional/file-checkpoint-backend.js'
import {
  FILE_CHECKPOINT_GIT_METADATA_CHANGED,
  FILE_CHECKPOINT_SOURCE_CHANGED,
} from '../core/transactional/file-checkpoint-git.js'
import { FileCheckpointDiagnosticError } from '../core/transactional/file-tree.js'
import { runShellCommand } from '../core/transactional/git-worktree.js'

const execFileAsync = promisify(execFile)
const tempDirs: string[] = []

async function createGitRepo(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'belay-fcp-backend-'))
  tempDirs.push(dir)
  await execFileAsync('git', ['init'], { cwd: dir })
  await execFileAsync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir })
  await execFileAsync('git', ['config', 'user.name', 'Test'], { cwd: dir })
  await writeFile(path.join(dir, 'README.md'), '# test\n')
  await execFileAsync('git', ['add', 'README.md'], { cwd: dir })
  await execFileAsync('git', ['commit', '-m', 'init'], { cwd: dir })
  return dir
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

function backendContext(
  repoRoot: string,
  fileCheckpointOverrides?: Partial<typeof DEFAULT_CONFIG_V3.policy.transactional.fileCheckpoint>,
) {
  return {
    repoRoot,
    stateDir: path.join(repoRoot, '.cursor', 'belay', 'transactional'),
    cwd: repoRoot,
    dirtyIgnoreRoots: protectedArtifactRoots(cursorAdapter.layout, repoRoot, null),
    fileCheckpoint: {
      ...DEFAULT_CONFIG_V3.policy.transactional.fileCheckpoint,
      enabled: true,
      ...fileCheckpointOverrides,
    },
    durableCheckpointEnabled: true,
    boundaryAttestation: containerIsolationAttestation(),
    boundaryAttestationFresh: true,
    boundaryDriverId: 'container' as const,
  }
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

describe('file checkpoint backend', () => {
  it('preserves all supported dirty Git baseline node states', async () => {
    const repoRoot = await createGitRepo()
    await writeFile(path.join(repoRoot, '.gitignore'), '*.ignored\n')
    await writeFile(path.join(repoRoot, 'deleted.txt'), 'delete me\n')
    await writeFile(path.join(repoRoot, 'executable.sh'), '#!/bin/sh\n', { mode: 0o644 })
    await symlink('README.md', path.join(repoRoot, 'current-link'))
    await execFileAsync('git', ['add', '.'], { cwd: repoRoot })
    await execFileAsync('git', ['commit', '-m', 'baseline nodes'], { cwd: repoRoot })

    await writeFile(path.join(repoRoot, 'README.md'), '# staged\n')
    await execFileAsync('git', ['add', 'README.md'], { cwd: repoRoot })
    await writeFile(path.join(repoRoot, 'README.md'), '# unstaged after staged\n')
    await rm(path.join(repoRoot, 'deleted.txt'))
    await writeFile(path.join(repoRoot, 'untracked.txt'), 'new\n')
    await writeFile(path.join(repoRoot, 'cache.ignored'), 'ignored but required\n')
    await chmod(path.join(repoRoot, 'executable.sh'), 0o755)
    await rm(path.join(repoRoot, 'current-link'))
    await symlink('untracked.txt', path.join(repoRoot, 'current-link'))

    const snapshot = await fileCheckpointBackend.prepare(backendContext(repoRoot))

    expect(snapshot.backend).toBe('file_checkpoint')
    expect(snapshot.resourceRoot).toBe(repoRoot)
    expect(snapshot.baselineTreeHash).toMatch(/^[a-f0-9]{64}$/)
    expect(snapshot.executionCwdRelative).toBe('')
    expect(await readFile(path.join(snapshot.executionRoot, 'README.md'), 'utf8')).toBe(
      '# unstaged after staged\n',
    )
    expect(await readFile(path.join(snapshot.executionRoot, 'untracked.txt'), 'utf8')).toBe('new\n')
    expect(await readFile(path.join(snapshot.executionRoot, 'cache.ignored'), 'utf8')).toBe(
      'ignored but required\n',
    )
    await expect(lstat(path.join(snapshot.executionRoot, 'deleted.txt'))).rejects.toThrow()
    expect((await lstat(path.join(snapshot.executionRoot, 'executable.sh'))).mode & 0o777).toBe(
      0o755,
    )
    expect(await readlink(path.join(snapshot.executionRoot, 'current-link'))).toBe('untracked.txt')
    const sourceStatus = (
      await execFileAsync('git', ['status', '--porcelain=v1'], { cwd: repoRoot })
    ).stdout
    const mirrorStatus = (
      await execFileAsync('git', ['status', '--porcelain=v1'], { cwd: snapshot.executionRoot })
    ).stdout
    expect(mirrorStatus).toBe(sourceStatus)

    await snapshot.cleanup()
  })

  it('observes safe command deltas in the execution mirror', async () => {
    const repoRoot = await createGitRepo()
    await writeFile(path.join(repoRoot, 'README.md'), '# dirty\n')

    const snapshot = await fileCheckpointBackend.prepare(backendContext(repoRoot))
    const result = await runShellCommand(
      'printf appended >> tracked.txt',
      snapshot.executionRoot,
      5_000,
    )
    expect(result.exitCode).toBe(0)

    const changes = await snapshot.collectChanges()
    expect(
      changes.some((change) => change.relativePath === 'tracked.txt' && change.kind === 'added'),
    ).toBe(true)

    await snapshot.cleanup()
  })

  it('rejects concurrent baseline drift during prepare', async () => {
    const repoRoot = await createGitRepo()
    await writeFile(path.join(repoRoot, 'README.md'), '# dirty\n')

    const fileTree = await import('../core/transactional/file-tree.js')
    const originalBuild = fileTree.buildFileTreeIndex
    let buildCalls = 0
    const buildSpy = vi
      .spyOn(fileTree, 'buildFileTreeIndex')
      .mockImplementation(async (options) => {
        buildCalls += 1
        if (buildCalls === 3 && options.resourceRoot === repoRoot) {
          await writeFile(path.join(repoRoot, 'README.md'), '# raced\n')
        }
        return originalBuild(options)
      })

    await expect(fileCheckpointBackend.prepare(backendContext(repoRoot))).rejects.toThrow(
      FILE_CHECKPOINT_SOURCE_CHANGED,
    )
    buildSpy.mockRestore()
  })

  it('rejects git metadata mutations observed after execution', async () => {
    const repoRoot = await createGitRepo()
    await writeFile(path.join(repoRoot, 'README.md'), '# dirty\n')

    const snapshot = await fileCheckpointBackend.prepare(backendContext(repoRoot))
    await writeFile(path.join(snapshot.executionRoot, '.git', 'HEAD'), 'ref: refs/heads/other\n')

    await expect(snapshot.collectChanges()).rejects.toThrow(FILE_CHECKPOINT_GIT_METADATA_CHANGED)
    await snapshot.cleanup()
  })

  it('rejects source worktree or Git metadata drift before apply', async () => {
    const repoRoot = await createGitRepo()
    await writeFile(path.join(repoRoot, 'README.md'), '# dirty\n')

    const snapshot = await fileCheckpointBackend.prepare(backendContext(repoRoot))
    await writeFile(path.join(repoRoot, 'concurrent.txt'), 'raced\n')
    await expect(snapshot.validateSourceState?.()).rejects.toThrow(FILE_CHECKPOINT_SOURCE_CHANGED)
    await rm(path.join(repoRoot, 'concurrent.txt'))
    await execFileAsync('git', ['update-ref', 'refs/heads/concurrent', 'HEAD'], { cwd: repoRoot })
    await expect(snapshot.validateSourceState?.()).rejects.toThrow(FILE_CHECKPOINT_SOURCE_CHANGED)

    await snapshot.cleanup()
  })

  it('counts Git metadata and both mirrors against the workspace quota', async () => {
    const repoRoot = await createGitRepo()
    await writeFile(path.join(repoRoot, 'README.md'), '# dirty\n')

    try {
      await fileCheckpointBackend.prepare(
        backendContext(repoRoot, {
          maxWorkspaceBytes: 1_024,
        }),
      )
      throw new Error('expected quota failure')
    } catch (error) {
      expect(error).toBeInstanceOf(FileCheckpointDiagnosticError)
      expect(error).toMatchObject({ message: 'file_checkpoint_quota_exceeded' })
      expect((error as FileCheckpointDiagnosticError).diagnostic).toMatch(
        /workspaceBytes=.*maxWorkspaceBytes=1024/,
      )
    }
  })

  it('preserves a supported split index in both mirrors', async () => {
    const repoRoot = await createGitRepo()
    await execFileAsync('git', ['config', 'core.splitIndex', 'true'], { cwd: repoRoot })
    await execFileAsync('git', ['update-index', '--split-index'], { cwd: repoRoot })
    await writeFile(path.join(repoRoot, 'README.md'), '# dirty split index\n')

    const snapshot = await fileCheckpointBackend.prepare(backendContext(repoRoot))
    const status = await execFileAsync('git', ['status', '--porcelain=v1'], {
      cwd: snapshot.executionRoot,
    })
    expect(status.stdout).toContain('README.md')

    await snapshot.cleanup()
  })

  it('preserves unrelated dirty files when one path changes in the mirror', async () => {
    const repoRoot = await createGitRepo()
    await writeFile(path.join(repoRoot, 'README.md'), '# dirty\n')
    await writeFile(path.join(repoRoot, 'other.txt'), 'stay\n')

    const snapshot = await fileCheckpointBackend.prepare(backendContext(repoRoot))
    await runShellCommand('printf changed > README.md', snapshot.executionRoot, 5_000)

    const changes = await snapshot.collectChanges()
    expect(changes).toHaveLength(1)
    expect(changes[0]).toMatchObject({ relativePath: 'README.md', kind: 'modified' })
    expect(await readFile(path.join(repoRoot, 'other.txt'), 'utf8')).toBe('stay\n')

    await snapshot.cleanup()
  })

  it('changes git metadata fingerprint when split-index state changes', async () => {
    const repoRoot = await createGitRepo()
    const { computeGitMetadataFingerprint } = await import(
      '../core/transactional/file-checkpoint-git.js'
    )
    await execFileAsync('git', ['config', 'core.splitIndex', 'true'], { cwd: repoRoot })
    await execFileAsync('git', ['update-index', '--split-index'], { cwd: repoRoot })
    const before = await computeGitMetadataFingerprint(repoRoot)

    await writeFile(path.join(repoRoot, 'README.md'), '# split index change\n')
    await execFileAsync('git', ['add', 'README.md'], { cwd: repoRoot })
    const after = await computeGitMetadataFingerprint(repoRoot)

    expect(before).not.toBe(after)
  })
})
