import { execFile } from 'node:child_process'
import {
  appendFile,
  chmod,
  link,
  lstat,
  mkdir,
  mkdtemp,
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

import { afterEach, describe, expect, it } from 'vitest'
import {
  CONTAINED_EXECUTION_CLEANUP_UNCONFIRMED,
  CONTAINED_EXECUTION_SOURCE_CHANGED,
  ContainedExecutionCleanupUnconfirmedError,
  type ContainedExecutionMirrorLimits,
  prepareContainedExecutionMirror,
  prepareContainedExecutionMirrorForTests,
  validateContainedExecutionMirrorLease,
  withContainedExecutionMirror,
  withContainedExecutionMirrorForTests,
} from '../core/contained-execution/mirror.js'
import {
  FILE_CHECKPOINT_HARDLINK_UNSUPPORTED,
  FILE_CHECKPOINT_PREPARE_TIMEOUT,
  FILE_CHECKPOINT_QUOTA_EXCEEDED,
  FILE_CHECKPOINT_UNSUPPORTED_NODE,
} from '../core/transactional/file-tree.js'

const execFileAsync = promisify(execFile)
const tempDirs: string[] = []

const generousLimits: ContainedExecutionMirrorLimits = {
  maxFiles: 10_000,
  maxSourceBytes: 64 * 1024 * 1024,
  maxWorkspaceBytes: 64 * 1024 * 1024,
  prepareTimeoutMs: 30_000,
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

async function temporaryDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), prefix))
  tempDirs.push(directory)
  return directory
}

async function createGitRepository(): Promise<string> {
  const repoRoot = await temporaryDirectory('belay-contained-git-')
  await execFileAsync('git', ['init'], { cwd: repoRoot })
  await execFileAsync('git', ['config', 'user.email', 'test@example.com'], { cwd: repoRoot })
  await execFileAsync('git', ['config', 'user.name', 'Test'], { cwd: repoRoot })
  await writeFile(path.join(repoRoot, '.gitignore'), 'runtime/\n')
  await writeFile(path.join(repoRoot, 'tracked.txt'), 'committed\n', { mode: 0o755 })
  await execFileAsync('git', ['add', '.gitignore', 'tracked.txt'], { cwd: repoRoot })
  await execFileAsync('git', ['commit', '-m', 'fixture'], { cwd: repoRoot })
  return repoRoot
}

function mirrorOptions(sourceRoot: string, controlPlaneRoots: string[] = []) {
  return { sourceRoot, controlPlaneRoots, limits: generousLimits }
}

async function expectAbsent(targetPath: string): Promise<void> {
  await expect(lstat(targetPath)).rejects.toMatchObject({ code: 'ENOENT' })
}

describe('contained execution mirror', () => {
  it('copies the actual clean Git filesystem without executing hooks, filters, or fsmonitor', async () => {
    const repoRoot = await createGitRepository()
    const hostMarker = path.join(await temporaryDirectory('belay-contained-marker-'), 'ran.txt')
    const hook = path.join(repoRoot, '.git', 'hooks', 'post-checkout')
    const fsmonitor = path.join(repoRoot, '.git', 'hooks', 'fsmonitor-test')
    await writeFile(hook, `#!/bin/sh\nprintf hook > '${hostMarker}'\n`)
    await writeFile(fsmonitor, `#!/bin/sh\nprintf fsmonitor > '${hostMarker}'\n`)
    await chmod(hook, 0o755)
    await chmod(fsmonitor, 0o755)
    await execFileAsync('git', ['config', 'core.fsmonitor', fsmonitor], { cwd: repoRoot })
    await mkdir(path.join(repoRoot, 'runtime'))
    await writeFile(path.join(repoRoot, 'runtime', 'ignored.txt'), 'current ignored\n')

    const mirror = await prepareContainedExecutionMirror(mirrorOptions(repoRoot))
    tempDirs.push(mirror.hostMirrorRoot)
    try {
      expect(mirror.backend).toBe('file_copy')
      expect(mirror.guestWorkspacePath).toBe(path.resolve(repoRoot))
      expect((await lstat(mirror.hostMirrorRoot)).mode & 0o777).toBe(0o700)
      await expect(
        readFile(path.join(mirror.hostMirrorRoot, 'runtime', 'ignored.txt'), 'utf8'),
      ).resolves.toBe('current ignored\n')
      await expectAbsent(path.join(mirror.hostMirrorRoot, '.git'))
      await expectAbsent(hostMarker)

      await writeFile(path.join(mirror.hostMirrorRoot, 'tracked.txt'), 'guest changed\n')
      await expect(readFile(path.join(repoRoot, 'tracked.txt'), 'utf8')).resolves.toBe(
        'committed\n',
      )
    } finally {
      await mirror.cleanup()
    }
  })

  it('copies dirty/untracked/ignored state while excluding control roots and unsafe links', async () => {
    const repoRoot = await createGitRepository()
    const outsideRoot = await temporaryDirectory('belay-contained-outside-')
    const controlPlaneRoot = path.join(repoRoot, '.belay-control')
    await chmod(repoRoot, 0o755)
    await writeFile(path.join(repoRoot, 'tracked.txt'), 'dirty\n', { mode: 0o6755 })
    await writeFile(path.join(repoRoot, 'untracked.txt'), 'untracked\n')
    await mkdir(path.join(repoRoot, 'runtime'), { recursive: true, mode: 0o1777 })
    await chmod(path.join(repoRoot, 'runtime'), 0o1777)
    await writeFile(path.join(repoRoot, 'runtime', 'dependency.txt'), 'ignored dependency\n')
    await mkdir(controlPlaneRoot, { recursive: true })
    await writeFile(path.join(controlPlaneRoot, 'secret.txt'), 'control data\n')
    await writeFile(path.join(outsideRoot, 'secret.txt'), 'outside\n')
    await symlink('tracked.txt', path.join(repoRoot, 'safe-link'))

    const mirror = await prepareContainedExecutionMirror(
      mirrorOptions(repoRoot, [controlPlaneRoot]),
    )
    tempDirs.push(mirror.hostMirrorRoot)
    try {
      await expect(readFile(path.join(mirror.hostMirrorRoot, 'tracked.txt'), 'utf8')).resolves.toBe(
        'dirty\n',
      )
      await expect(
        readFile(path.join(mirror.hostMirrorRoot, 'untracked.txt'), 'utf8'),
      ).resolves.toBe('untracked\n')
      await expect(
        readFile(path.join(mirror.hostMirrorRoot, 'runtime', 'dependency.txt'), 'utf8'),
      ).resolves.toBe('ignored dependency\n')
      expect((await lstat(path.join(mirror.hostMirrorRoot, 'tracked.txt'))).mode & 0o7777).toBe(
        0o755,
      )
      expect((await lstat(path.join(mirror.hostMirrorRoot, 'runtime'))).mode & 0o7777).toBe(0o777)
      expect(await readlink(path.join(mirror.hostMirrorRoot, 'safe-link'))).toBe('tracked.txt')
      await expectAbsent(path.join(mirror.hostMirrorRoot, '.belay-control'))
    } finally {
      await mirror.cleanup()
    }
  })

  it.each([
    'absolute outside',
    'relative escape',
    'protected',
    'broken',
    'canonical outside',
  ] as const)('rejects a %s symlink', async (kind) => {
    const sourceRoot = await temporaryDirectory('belay-contained-symlink-source-')
    const outsideRoot = await temporaryDirectory('belay-contained-symlink-outside-')
    const protectedRoot = path.join(sourceRoot, '.control')
    const outsideFile = path.join(outsideRoot, 'outside.txt')
    await mkdir(protectedRoot)
    await writeFile(path.join(protectedRoot, 'secret.txt'), 'protected\n')
    await writeFile(outsideFile, 'outside\n')

    const linkPath = path.join(sourceRoot, 'unsafe-link')
    if (kind === 'absolute outside') {
      await symlink(outsideFile, linkPath)
    } else if (kind === 'relative escape') {
      await symlink(path.relative(sourceRoot, outsideFile), linkPath)
    } else if (kind === 'protected') {
      await symlink('.control/secret.txt', linkPath)
    } else if (kind === 'broken') {
      await symlink('missing.txt', linkPath)
    } else {
      await symlink(outsideRoot, path.join(sourceRoot, 'intermediate'))
      await symlink('intermediate/outside.txt', linkPath)
    }

    await expect(
      prepareContainedExecutionMirror(mirrorOptions(sourceRoot, [protectedRoot])),
    ).rejects.toThrow('contained_execution_unsafe_symlink')
  })

  it('copies non-Git current state and preserves the caller-visible absolute guest path', async () => {
    const parent = await temporaryDirectory('belay-contained-nongit-')
    const sourceRoot = path.join(parent, 'source')
    const sourceAlias = path.join(parent, 'source-alias')
    await mkdir(sourceRoot)
    await writeFile(path.join(sourceRoot, 'runtime.txt'), 'current\n')
    await symlink(sourceRoot, sourceAlias)

    const mirror = await prepareContainedExecutionMirror(mirrorOptions(sourceAlias))
    tempDirs.push(mirror.hostMirrorRoot)
    try {
      expect(mirror.backend).toBe('file_copy')
      expect(mirror.guestWorkspacePath).toBe(path.resolve(sourceAlias))
      await expect(readFile(path.join(mirror.hostMirrorRoot, 'runtime.txt'), 'utf8')).resolves.toBe(
        'current\n',
      )
    } finally {
      await mirror.cleanup()
    }
  })

  it('hardens the exact allocated root to private permissions throughout preparation', async () => {
    const sourceRoot = await temporaryDirectory('belay-contained-private-source-')
    const allocatedRoot = path.join(await temporaryDirectory('belay-contained-private-'), 'mirror')
    await writeFile(path.join(sourceRoot, 'input.txt'), 'input\n')
    let allocationMode = 0
    let preparationMode = 0

    const mirror = await prepareContainedExecutionMirrorForTests(mirrorOptions(sourceRoot), {
      async makeTempRoot() {
        await mkdir(allocatedRoot, { mode: 0o755 })
        await chmod(allocatedRoot, 0o755)
        allocationMode = (await lstat(allocatedRoot)).mode & 0o777
        return allocatedRoot
      },
      async afterSnapshotCaptured() {
        preparationMode = (await lstat(allocatedRoot)).mode & 0o777
      },
    })

    expect(allocationMode).toBe(0o755)
    expect(preparationMode).toBe(0o700)
    expect((await lstat(mirror.hostMirrorRoot)).mode & 0o777).toBe(0o700)
    await mirror.cleanup()
    await expectAbsent(allocatedRoot)
  })

  it.each([
    'outside',
    'protected',
  ] as const)('rejects a regular file hard-linked to %s bytes', async (kind) => {
    const sourceRoot = await temporaryDirectory('belay-contained-hardlink-source-')
    const outsideRoot = await temporaryDirectory('belay-contained-hardlink-outside-')
    const protectedRoot = path.join(sourceRoot, '.control')
    await mkdir(protectedRoot)
    const target =
      kind === 'outside'
        ? path.join(outsideRoot, 'secret.txt')
        : path.join(protectedRoot, 'secret.txt')
    await writeFile(target, 'secret\n')
    await link(target, path.join(sourceRoot, 'visible-hardlink.txt'))

    await expect(
      prepareContainedExecutionMirror(mirrorOptions(sourceRoot, [protectedRoot])),
    ).rejects.toThrow(FILE_CHECKPOINT_HARDLINK_UNSUPPORTED)
  })

  it('revalidates hard-link count after opening the copy source descriptor', async () => {
    const sourceRoot = await temporaryDirectory('belay-contained-hardlink-race-source-')
    const outsideRoot = await temporaryDirectory('belay-contained-hardlink-race-outside-')
    const filePath = path.join(sourceRoot, 'input.txt')
    const outsidePath = path.join(outsideRoot, 'outside.txt')
    await writeFile(filePath, 'safe\n')
    await writeFile(outsidePath, 'outside\n')

    await expect(
      prepareContainedExecutionMirrorForTests(mirrorOptions(sourceRoot), {
        async beforeCopyOpen() {
          await rm(filePath)
          await link(outsidePath, filePath)
        },
      }),
    ).rejects.toThrow(FILE_CHECKPOINT_HARDLINK_UNSUPPORTED)
  })

  it('fails closed on sockets and other unsupported nodes', async () => {
    const sourceRoot = await temporaryDirectory('belay-contained-unsupported-')
    const socketPath = path.join(sourceRoot, 'runtime.sock')
    const server = createServer()
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(socketPath, resolve)
    })
    try {
      await expect(prepareContainedExecutionMirror(mirrorOptions(sourceRoot))).rejects.toThrow(
        FILE_CHECKPOINT_UNSUPPORTED_NODE,
      )
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()))
      })
    }
  })

  it('excludes case-insensitive and nested Git metadata segments', async () => {
    const sourceRoot = await temporaryDirectory('belay-contained-git-metadata-')
    await mkdir(path.join(sourceRoot, '.GIT', 'objects'), { recursive: true })
    await writeFile(path.join(sourceRoot, '.GIT', 'config'), 'secret config\n')
    await mkdir(path.join(sourceRoot, 'nested', '.git', 'hooks'), { recursive: true })
    await writeFile(path.join(sourceRoot, 'nested', '.git', 'hooks', 'post-checkout'), 'secret\n')
    await writeFile(path.join(sourceRoot, 'visible.txt'), 'visible\n')

    const mirror = await prepareContainedExecutionMirror(mirrorOptions(sourceRoot))
    tempDirs.push(mirror.hostMirrorRoot)
    try {
      await expectAbsent(path.join(mirror.hostMirrorRoot, '.GIT'))
      await expectAbsent(path.join(mirror.hostMirrorRoot, 'nested', '.git'))
      await expect(readFile(path.join(mirror.hostMirrorRoot, 'visible.txt'), 'utf8')).resolves.toBe(
        'visible\n',
      )
    } finally {
      await mirror.cleanup()
    }
  })

  it('copies current linked-worktree content without its Git pointer', async () => {
    const primaryRoot = await createGitRepository()
    const linkedRoot = await temporaryDirectory('belay-contained-linked-')
    await execFileAsync('git', ['worktree', 'add', '--detach', linkedRoot, 'HEAD'], {
      cwd: primaryRoot,
    })
    await mkdir(path.join(linkedRoot, 'runtime'))
    await writeFile(path.join(linkedRoot, 'runtime', 'ignored.txt'), 'linked ignored\n')
    await writeFile(path.join(linkedRoot, 'tracked.txt'), 'linked current\n')

    const mirror = await prepareContainedExecutionMirror(mirrorOptions(linkedRoot))
    tempDirs.push(mirror.hostMirrorRoot)
    try {
      await expect(readFile(path.join(mirror.hostMirrorRoot, 'tracked.txt'), 'utf8')).resolves.toBe(
        'linked current\n',
      )
      await expect(
        readFile(path.join(mirror.hostMirrorRoot, 'runtime', 'ignored.txt'), 'utf8'),
      ).resolves.toBe('linked ignored\n')
      await expectAbsent(path.join(mirror.hostMirrorRoot, '.git'))
    } finally {
      await mirror.cleanup()
    }
  })

  it('copies initialized submodule content and ignored state without nested Git metadata', async () => {
    const dependencyRoot = await createGitRepository()
    const sourceRoot = await createGitRepository()
    await execFileAsync(
      'git',
      [
        '-c',
        'protocol.file.allow=always',
        'submodule',
        'add',
        dependencyRoot,
        'modules/dependency',
      ],
      { cwd: sourceRoot },
    )
    await execFileAsync('git', ['commit', '-am', 'add submodule'], { cwd: sourceRoot })
    const dependencyCheckout = path.join(sourceRoot, 'modules', 'dependency')
    await mkdir(path.join(dependencyCheckout, 'runtime'))
    await writeFile(path.join(dependencyCheckout, 'runtime', 'ignored.txt'), 'submodule ignored\n')

    const mirror = await prepareContainedExecutionMirror(mirrorOptions(sourceRoot))
    tempDirs.push(mirror.hostMirrorRoot)
    try {
      await expect(
        readFile(path.join(mirror.hostMirrorRoot, 'modules', 'dependency', 'tracked.txt'), 'utf8'),
      ).resolves.toBe('committed\n')
      await expect(
        readFile(
          path.join(mirror.hostMirrorRoot, 'modules', 'dependency', 'runtime', 'ignored.txt'),
          'utf8',
        ),
      ).resolves.toBe('submodule ignored\n')
      await expectAbsent(path.join(mirror.hostMirrorRoot, 'modules', 'dependency', '.git'))
    } finally {
      await mirror.cleanup()
    }
  })

  it.each([
    ['max files', { maxFiles: 1 }, FILE_CHECKPOINT_QUOTA_EXCEEDED],
    ['source bytes', { maxSourceBytes: 3 }, FILE_CHECKPOINT_QUOTA_EXCEEDED],
    ['workspace bytes', { maxWorkspaceBytes: 3 }, FILE_CHECKPOINT_QUOTA_EXCEEDED],
  ] as const)('enforces the mandatory %s preparation limit', async (_label, limit, diagnostic) => {
    const sourceRoot = await temporaryDirectory('belay-contained-limit-')
    await writeFile(path.join(sourceRoot, 'one.txt'), '1234')
    await writeFile(path.join(sourceRoot, 'two.txt'), '1')

    await expect(
      prepareContainedExecutionMirror({
        sourceRoot,
        controlPlaneRoots: [],
        limits: { ...generousLimits, ...limit },
      }),
    ).rejects.toThrow(diagnostic)
  })

  it('enforces the preparation deadline during traversal', async () => {
    const sourceRoot = await temporaryDirectory('belay-contained-timeout-')
    await writeFile(path.join(sourceRoot, 'input.txt'), 'input\n')
    let now = 0

    await expect(
      prepareContainedExecutionMirrorForTests(
        {
          sourceRoot,
          controlPlaneRoots: [],
          limits: { ...generousLimits, prepareTimeoutMs: 1 },
        },
        {
          now() {
            now += 2
            return now
          },
        },
      ),
    ).rejects.toThrow(FILE_CHECKPOINT_PREPARE_TIMEOUT)
  })

  it('enforces source-byte limits against a file that grows while being copied', async () => {
    const sourceRoot = await temporaryDirectory('belay-contained-growing-')
    const inputPath = path.join(sourceRoot, 'input.txt')
    await writeFile(inputPath, '1234')
    let appended = false

    await expect(
      prepareContainedExecutionMirrorForTests(
        {
          sourceRoot,
          controlPlaneRoots: [],
          limits: { ...generousLimits, maxSourceBytes: 6 },
        },
        {
          async afterCopyRead() {
            if (!appended) {
              appended = true
              await appendFile(inputPath, '5678')
            }
          },
        },
      ),
    ).rejects.toThrow(FILE_CHECKPOINT_QUOTA_EXCEEDED)
  })

  it('fails closed when ordinary source content changes between snapshot and copy', async () => {
    const sourceRoot = await temporaryDirectory('belay-contained-race-')
    const inputPath = path.join(sourceRoot, 'input.txt')
    await writeFile(inputPath, 'before\n')

    await expect(
      prepareContainedExecutionMirrorForTests(mirrorOptions(sourceRoot), {
        async afterSnapshotCaptured() {
          await writeFile(inputPath, 'after\n')
        },
      }),
    ).rejects.toThrow(CONTAINED_EXECUTION_SOURCE_CHANGED)
  })

  it.each([
    ['zero exit', { exitCode: 0, timedOut: false }],
    ['nonzero exit', { exitCode: 7, timedOut: false }],
    ['timeout', { exitCode: null, timedOut: true }],
  ])('removes the mirror after an operation reports %s', async (_label, outcome) => {
    const sourceRoot = await temporaryDirectory('belay-contained-outcome-')
    await writeFile(path.join(sourceRoot, 'input.txt'), 'input\n')
    let mirrorRoot = ''

    await expect(
      withContainedExecutionMirror(mirrorOptions(sourceRoot), async (mirror) => {
        mirrorRoot = mirror.hostMirrorRoot
        return outcome
      }),
    ).resolves.toEqual(outcome)
    await expectAbsent(mirrorRoot)
  })

  it('removes the mirror when the guest operation throws', async () => {
    const sourceRoot = await temporaryDirectory('belay-contained-throw-')
    await writeFile(path.join(sourceRoot, 'input.txt'), 'input\n')
    let mirrorRoot = ''

    await expect(
      withContainedExecutionMirror(mirrorOptions(sourceRoot), async (mirror) => {
        mirrorRoot = mirror.hostMirrorRoot
        throw new Error('guest failed')
      }),
    ).rejects.toThrow('guest failed')
    await expectAbsent(mirrorRoot)
  })

  it('removes its exact temporary root when setup fails', async () => {
    const parent = await temporaryDirectory('belay-contained-setup-')
    const allocatedRoot = path.join(parent, 'allocated-mirror')

    await expect(
      prepareContainedExecutionMirrorForTests(mirrorOptions(path.join(parent, 'missing-source')), {
        async makeTempRoot() {
          await mkdir(allocatedRoot)
          return allocatedRoot
        },
      }),
    ).rejects.toThrow()
    await expectAbsent(allocatedRoot)
  })

  it('fails closed when cleanup cannot confirm exact-root removal and permits retry', async () => {
    const sourceRoot = await temporaryDirectory('belay-contained-cleanup-source-')
    const allocatedRoot = path.join(await temporaryDirectory('belay-contained-cleanup-'), 'mirror')
    await writeFile(path.join(sourceRoot, 'input.txt'), 'input\n')
    let blockRemoval = true

    const mirror = await prepareContainedExecutionMirrorForTests(mirrorOptions(sourceRoot), {
      async makeTempRoot() {
        await mkdir(allocatedRoot)
        return allocatedRoot
      },
      async removeRoot(root) {
        if (!blockRemoval) {
          await rm(root, { recursive: true, force: true })
        }
      },
    })

    await expect(mirror.cleanup()).rejects.toMatchObject({
      name: 'ContainedExecutionCleanupUnconfirmedError',
      code: CONTAINED_EXECUTION_CLEANUP_UNCONFIRMED,
    })
    await expect(lstat(allocatedRoot)).resolves.toBeDefined()

    blockRemoval = false
    await expect(mirror.cleanup()).resolves.toBeUndefined()
    await expect(mirror.cleanup()).resolves.toBeUndefined()
    await expectAbsent(allocatedRoot)
  })

  it('accepts only the exact live opaque lease and bound provenance', async () => {
    const sourceRoot = await temporaryDirectory('belay-contained-lease-source-')
    const protectedRoot = await temporaryDirectory('belay-contained-lease-protected-')
    await writeFile(path.join(sourceRoot, 'input.txt'), 'input\n')
    const mirror = await prepareContainedExecutionMirror(mirrorOptions(sourceRoot, [protectedRoot]))

    expect(
      validateContainedExecutionMirrorLease(mirror, {
        sourceRoot,
        protectedRoots: [protectedRoot],
      }),
    ).toBe(true)
    expect(
      validateContainedExecutionMirrorLease(
        { ...mirror },
        { sourceRoot, protectedRoots: [protectedRoot] },
      ),
    ).toBe(false)
    expect(validateContainedExecutionMirrorLease(mirror, { sourceRoot, protectedRoots: [] })).toBe(
      false,
    )

    await mirror.cleanup()
    expect(
      validateContainedExecutionMirrorLease(mirror, {
        sourceRoot,
        protectedRoots: [protectedRoot],
      }),
    ).toBe(false)
  })

  it('prefers cleanup-unconfirmed over an operation failure', async () => {
    const sourceRoot = await temporaryDirectory('belay-contained-cleanup-priority-source-')
    const allocatedRoot = path.join(
      await temporaryDirectory('belay-contained-cleanup-priority-'),
      'mirror',
    )
    await writeFile(path.join(sourceRoot, 'input.txt'), 'input\n')

    await expect(
      withContainedExecutionMirrorForTests(
        mirrorOptions(sourceRoot),
        async () => {
          throw new Error('guest failed')
        },
        {
          async makeTempRoot() {
            await mkdir(allocatedRoot)
            return allocatedRoot
          },
          async removeRoot() {
            // Simulate removal returning without deleting the owned root.
          },
        },
      ),
    ).rejects.toBeInstanceOf(ContainedExecutionCleanupUnconfirmedError)
    await rm(allocatedRoot, { recursive: true, force: true })
  })
})
