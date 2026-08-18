import { execFile } from 'node:child_process'
import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'

import { afterEach, describe, expect, it } from 'vitest'
import {
  CONTAINED_EXECUTION_CLEANUP_UNCONFIRMED,
  ContainedExecutionCleanupUnconfirmedError,
  prepareContainedExecutionMirror,
  prepareContainedExecutionMirrorForTests,
  withContainedExecutionMirror,
  withContainedExecutionMirrorForTests,
} from '../core/contained-execution/mirror.js'

const execFileAsync = promisify(execFile)
const tempDirs: string[] = []

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

async function expectAbsent(targetPath: string): Promise<void> {
  await expect(lstat(targetPath)).rejects.toMatchObject({ code: 'ENOENT' })
}

describe('contained execution mirror', () => {
  it('materializes clean Git content without exposing Git metadata or untracked host state', async () => {
    const repoRoot = await createGitRepository()
    await mkdir(path.join(repoRoot, 'runtime'))
    await writeFile(path.join(repoRoot, 'runtime', 'ignored.txt'), 'host only\n')

    const mirror = await prepareContainedExecutionMirror({ sourceRoot: repoRoot })
    tempDirs.push(mirror.hostMirrorRoot)
    try {
      expect(mirror.backend).toBe('clean_git_worktree')
      expect(mirror.guestWorkspacePath).toBe(path.resolve(repoRoot))
      await expect(readFile(path.join(mirror.hostMirrorRoot, 'tracked.txt'), 'utf8')).resolves.toBe(
        'committed\n',
      )
      await expectAbsent(path.join(mirror.hostMirrorRoot, '.git'))
      await expectAbsent(path.join(mirror.hostMirrorRoot, 'runtime', 'ignored.txt'))
      await expect(
        execFileAsync('git', ['rev-parse', '--git-dir'], { cwd: mirror.hostMirrorRoot }),
      ).rejects.toThrow()

      await writeFile(path.join(mirror.hostMirrorRoot, 'tracked.txt'), 'guest changed\n')
      await expect(readFile(path.join(repoRoot, 'tracked.txt'), 'utf8')).resolves.toBe(
        'committed\n',
      )
    } finally {
      await mirror.cleanup()
    }
  })

  it('copies dirty Git state, ignored runtime dependencies, safe links, and modes only', async () => {
    const repoRoot = await createGitRepository()
    const outsideRoot = await temporaryDirectory('belay-contained-outside-')
    const controlPlaneRoot = path.join(repoRoot, '.belay-control')
    await writeFile(path.join(repoRoot, 'tracked.txt'), 'dirty\n', { mode: 0o755 })
    await writeFile(path.join(repoRoot, 'untracked.txt'), 'untracked\n')
    await mkdir(path.join(repoRoot, 'runtime'), { recursive: true })
    await writeFile(path.join(repoRoot, 'runtime', 'dependency.txt'), 'ignored dependency\n')
    await mkdir(controlPlaneRoot, { recursive: true })
    await writeFile(path.join(controlPlaneRoot, 'secret.txt'), 'control data\n')
    await writeFile(path.join(outsideRoot, 'secret.txt'), 'outside\n')
    await symlink('tracked.txt', path.join(repoRoot, 'safe-link'))
    await symlink(path.join(outsideRoot, 'secret.txt'), path.join(repoRoot, 'outside-link'))

    const socketPath = path.join(repoRoot, 'runtime.sock')
    const server = createServer()
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(socketPath, resolve)
    })

    let mirror: Awaited<ReturnType<typeof prepareContainedExecutionMirror>> | undefined
    try {
      mirror = await prepareContainedExecutionMirror({
        sourceRoot: repoRoot,
        controlPlaneRoots: [controlPlaneRoot],
      })
      tempDirs.push(mirror.hostMirrorRoot)

      expect(mirror.backend).toBe('file_copy')
      await expect(readFile(path.join(mirror.hostMirrorRoot, 'tracked.txt'), 'utf8')).resolves.toBe(
        'dirty\n',
      )
      await expect(
        readFile(path.join(mirror.hostMirrorRoot, 'untracked.txt'), 'utf8'),
      ).resolves.toBe('untracked\n')
      await expect(
        readFile(path.join(mirror.hostMirrorRoot, 'runtime', 'dependency.txt'), 'utf8'),
      ).resolves.toBe('ignored dependency\n')
      expect((await lstat(path.join(mirror.hostMirrorRoot, 'tracked.txt'))).mode & 0o777).toBe(
        0o755,
      )
      expect((await lstat(path.join(mirror.hostMirrorRoot, 'safe-link'))).isSymbolicLink()).toBe(
        true,
      )
      await expectAbsent(path.join(mirror.hostMirrorRoot, '.git'))
      await expectAbsent(path.join(mirror.hostMirrorRoot, '.belay-control'))
      await expectAbsent(path.join(mirror.hostMirrorRoot, 'outside-link'))
      await expectAbsent(path.join(mirror.hostMirrorRoot, 'runtime.sock'))

      await writeFile(path.join(mirror.hostMirrorRoot, 'tracked.txt'), 'guest changed\n')
      await expect(readFile(path.join(repoRoot, 'tracked.txt'), 'utf8')).resolves.toBe('dirty\n')
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()))
      })
      await mirror?.cleanup()
    }
  })

  it('copies non-Git current state and preserves the caller-visible absolute guest path', async () => {
    const parent = await temporaryDirectory('belay-contained-nongit-')
    const sourceRoot = path.join(parent, 'source')
    const sourceAlias = path.join(parent, 'source-alias')
    await mkdir(sourceRoot)
    await writeFile(path.join(sourceRoot, 'runtime.txt'), 'current\n')
    await symlink(sourceRoot, sourceAlias)

    const mirror = await prepareContainedExecutionMirror({ sourceRoot: sourceAlias })
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

  it.each([
    ['zero exit', { exitCode: 0, timedOut: false }],
    ['nonzero exit', { exitCode: 7, timedOut: false }],
    ['timeout', { exitCode: null, timedOut: true }],
  ])('removes the mirror after an operation reports %s', async (_label, outcome) => {
    const sourceRoot = await temporaryDirectory('belay-contained-outcome-')
    await writeFile(path.join(sourceRoot, 'input.txt'), 'input\n')
    let mirrorRoot = ''

    await expect(
      withContainedExecutionMirror({ sourceRoot }, async (mirror) => {
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
      withContainedExecutionMirror({ sourceRoot }, async (mirror) => {
        mirrorRoot = mirror.hostMirrorRoot
        throw new Error('guest failed')
      }),
    ).rejects.toThrow('guest failed')

    await expectAbsent(mirrorRoot)
  })

  it('removes its temporary root when setup fails', async () => {
    const parent = await temporaryDirectory('belay-contained-setup-')
    const allocatedRoot = path.join(parent, 'allocated-mirror')

    await expect(
      prepareContainedExecutionMirrorForTests(
        { sourceRoot: path.join(parent, 'missing-source') },
        {
          async makeTempRoot() {
            await mkdir(allocatedRoot)
            return allocatedRoot
          },
        },
      ),
    ).rejects.toThrow()

    await expectAbsent(allocatedRoot)
  })

  it('fails closed when cleanup cannot confirm removal and permits a later retry', async () => {
    const sourceRoot = await temporaryDirectory('belay-contained-cleanup-source-')
    const allocatedRoot = path.join(await temporaryDirectory('belay-contained-cleanup-'), 'mirror')
    await writeFile(path.join(sourceRoot, 'input.txt'), 'input\n')
    let blockRemoval = true

    const mirror = await prepareContainedExecutionMirrorForTests(
      { sourceRoot },
      {
        async makeTempRoot() {
          await mkdir(allocatedRoot)
          return allocatedRoot
        },
        async removeRoot(root) {
          if (!blockRemoval) {
            await rm(root, { recursive: true, force: true })
          }
        },
      },
    )

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

  it('prefers a cleanup-unconfirmed error over an operation failure', async () => {
    const sourceRoot = await temporaryDirectory('belay-contained-cleanup-priority-source-')
    const allocatedRoot = path.join(
      await temporaryDirectory('belay-contained-cleanup-priority-'),
      'mirror',
    )
    await writeFile(path.join(sourceRoot, 'input.txt'), 'input\n')

    await expect(
      withContainedExecutionMirrorForTests(
        { sourceRoot },
        async () => {
          throw new Error('guest failed')
        },
        {
          async makeTempRoot() {
            await mkdir(allocatedRoot)
            return allocatedRoot
          },
          async removeRoot() {
            // Simulate an OS/runtime cleanup that returned without removing the mirror.
          },
        },
      ),
    ).rejects.toBeInstanceOf(ContainedExecutionCleanupUnconfirmedError)

    await rm(allocatedRoot, { recursive: true, force: true })
  })
})
