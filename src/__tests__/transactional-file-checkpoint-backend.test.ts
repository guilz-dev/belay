import { execFile } from 'node:child_process'
import {
  chmod,
  link,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  readlink,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { createServer } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'

import { afterEach, describe, expect, it, vi } from 'vitest'
import { cursorAdapter } from '../adapters/cursor/adapter.js'
import { protectedArtifactRoots } from '../adapters/layouts/protected-paths.js'
import type { BoundaryAttestation } from '../core/capability/attestation.js'
import { DEFAULT_CONFIG_V3 } from '../core/config.js'
import {
  FILE_CHECKPOINT_PROTECTED_PATH_CHANGED,
  fileCheckpointBackend,
} from '../core/transactional/file-checkpoint-backend.js'
import {
  FILE_CHECKPOINT_CWD_OUTSIDE_ROOT,
  FILE_CHECKPOINT_GIT_METADATA_CHANGED,
  FILE_CHECKPOINT_SOURCE_CHANGED,
} from '../core/transactional/file-checkpoint-git.js'
import {
  buildFileTreeIndex,
  FILE_CHECKPOINT_HARDLINK_UNSUPPORTED,
  FILE_CHECKPOINT_NESTED_REPOSITORY,
  FILE_CHECKPOINT_PREPARE_TIMEOUT,
  FILE_CHECKPOINT_QUOTA_EXCEEDED,
  FILE_CHECKPOINT_UNSUPPORTED_NODE,
  FileCheckpointDiagnosticError,
} from '../core/transactional/file-tree.js'
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
  options?: { cwd?: string },
) {
  return {
    repoRoot,
    stateDir: path.join(repoRoot, '.cursor', 'belay', 'transactional'),
    cwd: options?.cwd ?? repoRoot,
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

async function createPlainWorkspace(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'belay-fcp-nongit-'))
  tempDirs.push(dir)
  return dir
}

function nonGitBackendContext(
  workspaceRoot: string,
  fileCheckpointOverrides?: Partial<typeof DEFAULT_CONFIG_V3.policy.transactional.fileCheckpoint>,
  options?: { cwd?: string },
) {
  return backendContext(
    workspaceRoot,
    {
      allowNonGit: true,
      ...fileCheckpointOverrides,
    },
    options,
  )
}

async function sourceTreeHash(workspaceRoot: string): Promise<string> {
  return (await buildFileTreeIndex({ resourceRoot: workspaceRoot })).treeHash
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
  }, 15_000)

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

describe('non-git file checkpoint backend', () => {
  it('preserves plain-directory files, directories, modes, and symlinks', async () => {
    const workspaceRoot = await createPlainWorkspace()
    await mkdir(path.join(workspaceRoot, 'nested'), { recursive: true })
    await writeFile(path.join(workspaceRoot, 'nested', 'note.txt'), 'hello\n', { mode: 0o644 })
    await chmod(path.join(workspaceRoot, 'nested', 'note.txt'), 0o755)
    await writeFile(path.join(workspaceRoot, 'exec.sh'), '#!/bin/sh\n', { mode: 0o755 })
    await symlink('nested/note.txt', path.join(workspaceRoot, 'current-link'))

    const snapshot = await fileCheckpointBackend.prepare(nonGitBackendContext(workspaceRoot))

    expect(snapshot.resourceKind).toBe('directory')
    expect(snapshot.baselineTreeHash).toMatch(/^[a-f0-9]{64}$/)
    expect(await readFile(path.join(snapshot.executionRoot, 'nested', 'note.txt'), 'utf8')).toBe(
      'hello\n',
    )
    expect(
      (await lstat(path.join(snapshot.executionRoot, 'nested', 'note.txt'))).mode & 0o777,
    ).toBe(0o755)
    expect(await readlink(path.join(snapshot.executionRoot, 'current-link'))).toBe(
      'nested/note.txt',
    )

    await snapshot.cleanup()
  })

  it('records nested cwd as the correct relative path', async () => {
    const workspaceRoot = await createPlainWorkspace()
    await mkdir(path.join(workspaceRoot, 'pkg', 'src'), { recursive: true })
    await writeFile(path.join(workspaceRoot, 'pkg', 'src', 'main.ts'), 'export {}\n')

    const snapshot = await fileCheckpointBackend.prepare(
      nonGitBackendContext(workspaceRoot, undefined, {
        cwd: path.join(workspaceRoot, 'pkg', 'src'),
      }),
    )

    expect(snapshot.executionCwdRelative).toBe('pkg/src')
    await snapshot.cleanup()
  })

  it('rejects cwd outside the workspace root before preparation', async () => {
    const workspaceRoot = await createPlainWorkspace()
    const outside = await mkdtemp(path.join(os.tmpdir(), 'belay-fcp-outside-'))
    tempDirs.push(outside)
    await writeFile(path.join(workspaceRoot, 'README.md'), '# plain\n')

    const beforeHash = await sourceTreeHash(workspaceRoot)
    await expect(
      fileCheckpointBackend.prepare(
        nonGitBackendContext(workspaceRoot, undefined, { cwd: outside }),
      ),
    ).rejects.toThrow(FILE_CHECKPOINT_CWD_OUTSIDE_ROOT)
    expect(await sourceTreeHash(workspaceRoot)).toBe(beforeHash)

    await rm(outside, { recursive: true, force: true })
  })

  it('rejects concurrent baseline drift during prepare', async () => {
    const workspaceRoot = await createPlainWorkspace()
    await writeFile(path.join(workspaceRoot, 'README.md'), '# plain\n')
    const beforeHash = await sourceTreeHash(workspaceRoot)
    const entriesBefore = (await readdir(workspaceRoot)).sort()

    const fileTree = await import('../core/transactional/file-tree.js')
    const originalBuild = fileTree.buildFileTreeIndex
    let buildCalls = 0
    const buildSpy = vi
      .spyOn(fileTree, 'buildFileTreeIndex')
      .mockImplementation(async (options) => {
        buildCalls += 1
        if (buildCalls === 3 && options.resourceRoot === workspaceRoot) {
          await writeFile(path.join(workspaceRoot, 'README.md'), '# raced\n')
        }
        return originalBuild(options)
      })

    await expect(
      fileCheckpointBackend.prepare(nonGitBackendContext(workspaceRoot)),
    ).rejects.toThrow(FILE_CHECKPOINT_SOURCE_CHANGED)
    expect((await readdir(workspaceRoot)).sort()).toEqual(entriesBefore)
    await writeFile(path.join(workspaceRoot, 'README.md'), '# plain\n')
    expect(await sourceTreeHash(workspaceRoot)).toBe(beforeHash)
    buildSpy.mockRestore()
  })

  it('rejects directory identity drift before apply', async () => {
    const workspaceRoot = await createPlainWorkspace()
    await writeFile(path.join(workspaceRoot, 'README.md'), '# plain\n')

    const snapshot = await fileCheckpointBackend.prepare(nonGitBackendContext(workspaceRoot))
    const resourceIdentity = await import('../core/recovery/resource-identity.js')
    const identitySpy = vi
      .spyOn(resourceIdentity, 'currentRecoveryResourceIdentity')
      .mockResolvedValue('replacement-identity')

    await expect(snapshot.validateSourceState?.()).rejects.toThrow(FILE_CHECKPOINT_SOURCE_CHANGED)
    identitySpy.mockRestore()
    await snapshot.cleanup()
  })

  it('observes safe command deltas in the execution mirror', async () => {
    const workspaceRoot = await createPlainWorkspace()
    await writeFile(path.join(workspaceRoot, 'README.md'), '# plain\n')

    const snapshot = await fileCheckpointBackend.prepare(nonGitBackendContext(workspaceRoot))
    const result = await runShellCommand(
      'printf appended > tracked.txt',
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

  it('keeps an unprotected sibling of a protected root in both mirrors', async () => {
    const workspaceRoot = await createPlainWorkspace()
    const protectedDir = path.join(workspaceRoot, 'managed')
    const siblingDir = path.join(workspaceRoot, 'sibling')
    await mkdir(protectedDir, { recursive: true })
    await mkdir(siblingDir, { recursive: true })
    await writeFile(path.join(protectedDir, 'secret.txt'), 'hidden\n')
    await writeFile(path.join(siblingDir, 'visible.txt'), 'stay\n')
    await writeFile(path.join(workspaceRoot, 'README.md'), '# plain\n')

    const snapshot = await fileCheckpointBackend.prepare({
      ...nonGitBackendContext(workspaceRoot),
      dirtyIgnoreRoots: [protectedDir],
    })
    if (!snapshot.baselineRoot) {
      throw new Error('expected baseline root')
    }
    expect(await readFile(path.join(snapshot.baselineRoot, 'sibling', 'visible.txt'), 'utf8')).toBe(
      'stay\n',
    )
    expect(
      await readFile(path.join(snapshot.executionRoot, 'sibling', 'visible.txt'), 'utf8'),
    ).toBe('stay\n')
    await expect(
      readFile(path.join(snapshot.baselineRoot, 'managed', 'secret.txt'), 'utf8'),
    ).rejects.toThrow()
    await expect(
      readFile(path.join(snapshot.executionRoot, 'managed', 'secret.txt'), 'utf8'),
    ).rejects.toThrow()

    await snapshot.cleanup()
  })

  it('rejects protected path mutations in the execution mirror', async () => {
    const workspaceRoot = await createPlainWorkspace()
    const protectedDir = path.join(workspaceRoot, 'managed')
    await mkdir(protectedDir, { recursive: true })
    await writeFile(path.join(protectedDir, 'secret.txt'), 'hidden\n')
    await writeFile(path.join(workspaceRoot, 'README.md'), '# plain\n')

    const snapshot = await fileCheckpointBackend.prepare({
      ...nonGitBackendContext(workspaceRoot),
      dirtyIgnoreRoots: [protectedDir],
    })
    await mkdir(path.join(snapshot.executionRoot, 'managed'), { recursive: true })
    await writeFile(path.join(snapshot.executionRoot, 'managed', 'secret.txt'), 'mutated\n')

    await expect(snapshot.collectChanges()).rejects.toThrow(FILE_CHECKPOINT_PROTECTED_PATH_CHANGED)
    await snapshot.cleanup()
  })

  it('prepares an empty visible workspace', async () => {
    const workspaceRoot = await createPlainWorkspace()

    const snapshot = await fileCheckpointBackend.prepare(nonGitBackendContext(workspaceRoot))

    expect(snapshot.snapshotFileCount).toBe(0)
    expect(snapshot.baselineTreeHash).toMatch(/^[a-f0-9]{64}$/)
    await snapshot.cleanup()
  })

  it('rejects nested repositories, hardlinks, sockets, and fifos without mutating source', async () => {
    const nestedGitRoot = await createPlainWorkspace()
    await writeFile(path.join(nestedGitRoot, 'README.md'), '# plain\n')
    const nestedBefore = await readFile(path.join(nestedGitRoot, 'README.md'), 'utf8')
    await mkdir(path.join(nestedGitRoot, 'pkg', '.git'), { recursive: true })
    await expect(
      fileCheckpointBackend.prepare(nonGitBackendContext(nestedGitRoot)),
    ).rejects.toThrow(FILE_CHECKPOINT_NESTED_REPOSITORY)
    expect(await readFile(path.join(nestedGitRoot, 'README.md'), 'utf8')).toBe(nestedBefore)

    const hardlinkRoot = await createPlainWorkspace()
    await writeFile(path.join(hardlinkRoot, 'original.txt'), 'linked\n')
    const hardlinkBefore = await readFile(path.join(hardlinkRoot, 'original.txt'), 'utf8')
    await link(path.join(hardlinkRoot, 'original.txt'), path.join(hardlinkRoot, 'linked.txt'))
    await expect(fileCheckpointBackend.prepare(nonGitBackendContext(hardlinkRoot))).rejects.toThrow(
      FILE_CHECKPOINT_HARDLINK_UNSUPPORTED,
    )
    expect(await readFile(path.join(hardlinkRoot, 'original.txt'), 'utf8')).toBe(hardlinkBefore)

    const fifoRoot = await createPlainWorkspace()
    await writeFile(path.join(fifoRoot, 'README.md'), '# plain\n')
    const fifoBefore = await readFile(path.join(fifoRoot, 'README.md'), 'utf8')
    await execFileAsync('mkfifo', [path.join(fifoRoot, 'pipe')])
    await expect(fileCheckpointBackend.prepare(nonGitBackendContext(fifoRoot))).rejects.toThrow(
      FILE_CHECKPOINT_UNSUPPORTED_NODE,
    )
    expect(await readFile(path.join(fifoRoot, 'README.md'), 'utf8')).toBe(fifoBefore)

    const socketRoot = await createPlainWorkspace()
    await writeFile(path.join(socketRoot, 'README.md'), '# plain\n')
    const socketBefore = await readFile(path.join(socketRoot, 'README.md'), 'utf8')
    const socketPath = path.join(socketRoot, 'service.sock')
    const server = createServer()
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(socketPath, resolve)
    })
    try {
      await expect(fileCheckpointBackend.prepare(nonGitBackendContext(socketRoot))).rejects.toThrow(
        FILE_CHECKPOINT_UNSUPPORTED_NODE,
      )
      expect(await readFile(path.join(socketRoot, 'README.md'), 'utf8')).toBe(socketBefore)
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()))
      })
    }
  })

  it('rejects quota overflow and prepare timeout without mutating source', async () => {
    const quotaRoot = await createPlainWorkspace()
    await writeFile(path.join(quotaRoot, 'README.md'), '# plain\n')
    await writeFile(path.join(quotaRoot, 'second.txt'), 'more\n')
    const quotaBefore = await sourceTreeHash(quotaRoot)

    try {
      await fileCheckpointBackend.prepare(
        nonGitBackendContext(quotaRoot, {
          maxFiles: 1,
        }),
      )
      throw new Error('expected quota failure')
    } catch (error) {
      expect(error).toBeInstanceOf(FileCheckpointDiagnosticError)
      expect(error).toMatchObject({ message: FILE_CHECKPOINT_QUOTA_EXCEEDED })
    }
    expect(await sourceTreeHash(quotaRoot)).toBe(quotaBefore)

    const timeoutRoot = await createPlainWorkspace()
    await writeFile(path.join(timeoutRoot, 'README.md'), '# plain\n')
    const timeoutBefore = await sourceTreeHash(timeoutRoot)
    await expect(
      fileCheckpointBackend.prepare(
        nonGitBackendContext(timeoutRoot, {
          prepareTimeoutMs: 0,
        }),
      ),
    ).rejects.toMatchObject({ message: FILE_CHECKPOINT_PREPARE_TIMEOUT })
    expect(await sourceTreeHash(timeoutRoot)).toBe(timeoutBefore)
  })

  it('detects root replacement during prepare', async () => {
    const workspaceRoot = await createPlainWorkspace()
    await writeFile(path.join(workspaceRoot, 'README.md'), '# plain\n')

    const resourceIdentity = await import('../core/recovery/resource-identity.js')
    const originalIdentity = resourceIdentity.currentRecoveryResourceIdentity
    let identityCalls = 0
    const identitySpy = vi
      .spyOn(resourceIdentity, 'currentRecoveryResourceIdentity')
      .mockImplementation(async (root, kind) => {
        identityCalls += 1
        if (identityCalls === 2) {
          return 'replacement-identity'
        }
        return originalIdentity(root, kind)
      })

    const beforeHash = await sourceTreeHash(workspaceRoot)
    await expect(
      fileCheckpointBackend.prepare(nonGitBackendContext(workspaceRoot)),
    ).rejects.toThrow(FILE_CHECKPOINT_SOURCE_CHANGED)
    expect(await sourceTreeHash(workspaceRoot)).toBe(beforeHash)
    identitySpy.mockRestore()
  })

  it('probes non-git eligibility only when allowNonGit is enabled', async () => {
    const workspaceRoot = await createPlainWorkspace()
    await writeFile(path.join(workspaceRoot, 'README.md'), '# plain\n')

    const disabled = await fileCheckpointBackend.probe(backendContext(workspaceRoot))
    expect(disabled.eligible).toBe(false)
    expect(disabled.reason).toBe('file_checkpoint_non_git_disabled')

    const enabled = await fileCheckpointBackend.probe(nonGitBackendContext(workspaceRoot))
    expect(enabled.eligible).toBe(true)
    expect(enabled.signals).toContain('non_git_file_checkpoint')
  })
})
