import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
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
  FILE_CHECKPOINT_BASELINE_MISMATCH,
  FILE_CHECKPOINT_GIT_METADATA_CHANGED,
} from '../core/transactional/file-checkpoint-git.js'
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

function backendContext(repoRoot: string) {
  return {
    repoRoot,
    stateDir: path.join(repoRoot, '.cursor', 'belay', 'transactional'),
    cwd: repoRoot,
    dirtyIgnoreRoots: protectedArtifactRoots(cursorAdapter.layout, repoRoot, null),
    fileCheckpoint: {
      ...DEFAULT_CONFIG_V3.policy.transactional.fileCheckpoint,
      enabled: true,
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
  it('prepares dirty Git mirrors with staged and unstaged baseline state', async () => {
    const repoRoot = await createGitRepo()
    await writeFile(path.join(repoRoot, 'README.md'), '# dirty\n')
    await writeFile(path.join(repoRoot, 'untracked.txt'), 'new\n')
    await execFileAsync('git', ['add', 'README.md'], { cwd: repoRoot })

    const snapshot = await fileCheckpointBackend.prepare(backendContext(repoRoot))

    expect(snapshot.backend).toBe('file_checkpoint')
    expect(snapshot.resourceRoot).toBe(repoRoot)
    expect(snapshot.baselineTreeHash).toMatch(/^[a-f0-9]{64}$/)
    expect(snapshot.executionCwdRelative).toBe('')
    expect(await readFile(path.join(snapshot.executionRoot, 'README.md'), 'utf8')).toBe('# dirty\n')
    expect(await readFile(path.join(snapshot.executionRoot, 'untracked.txt'), 'utf8')).toBe('new\n')

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
      FILE_CHECKPOINT_BASELINE_MISMATCH,
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
})
