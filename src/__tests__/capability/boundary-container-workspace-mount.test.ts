import { access, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import {
  buildContainerRunArgs,
  createContainerBoundaryDriver,
  isDockerAvailable,
} from '../../core/capability/boundary-driver-container.js'
import { resolveGuestWorkdir } from '../../core/capability/boundary-workspace-mount.js'
import { canonicalPath } from '../../core/path-utils.js'

const dockerAvailable = await isDockerAvailable()
const DOCKER_TEST_TIMEOUT_MS = 60_000

async function pathExists(target: string): Promise<boolean> {
  try {
    await access(target)
    return true
  } catch {
    return false
  }
}

describe('container workspace mount isolation', () => {
  it('uses an isolated mirror mount instead of the host workspace bind', () => {
    const args = buildContainerRunArgs({
      image: 'alpine:3.20',
      command: 'touch test.txt',
      cwd: '/workspace/project',
      proxyEnv: {},
      mountReadOnly: true,
      repoRoot: '/workspace/project',
      runOptions: {
        workspaceMount: {
          hostSourceRoot: '/tmp/belay-mirror',
          guestTargetRoot: '/workspace/project',
          cwdRelative: '.',
          writable: true,
          hideHostSourcePath: true,
        },
      },
    })

    expect(args).toContain('--mount')
    expect(args).toContain(
      `type=bind,src=${canonicalPath('/tmp/belay-mirror')},dst=/workspace/project`,
    )
    expect(args).not.toContain('-v')
    expect(args).not.toContain('/tmp/belay-mirror:/tmp/belay-mirror')
  })

  it('rejects an alternate guest target before a parent source can expose the workspace', async () => {
    const driver = createContainerBoundaryDriver({ repoRoot: '/safe/repo' })

    await expect(
      driver.run('true', '/workspace', 1_000, {
        workspaceMount: {
          hostSourceRoot: '/safe',
          guestTargetRoot: '/workspace',
          cwdRelative: '.',
          writable: true,
          hideHostSourcePath: true,
        },
      }),
    ).rejects.toThrow('boundary_workspace_mount_target_mismatch')
  })

  it.skipIf(!dockerAvailable)(
    'mutates only the execution mirror when commands use absolute workspace paths',
    async () => {
      const hostRoot = canonicalPath(await mkdtemp(path.join(os.tmpdir(), 'belay-host-root-')))
      const mirrorRoot = canonicalPath(await mkdtemp(path.join(os.tmpdir(), 'belay-mirror-root-')))
      await writeFile(path.join(hostRoot, 'marker.txt'), 'host\n')
      await mkdir(mirrorRoot, { recursive: true })
      await writeFile(path.join(mirrorRoot, 'marker.txt'), 'mirror\n')

      const workspaceMount = {
        hostSourceRoot: mirrorRoot,
        guestTargetRoot: hostRoot,
        cwdRelative: '.',
        writable: true,
        hideHostSourcePath: true,
      }
      const driver = createContainerBoundaryDriver({ repoRoot: hostRoot })
      const workdir = resolveGuestWorkdir(workspaceMount)
      const markerPath = path.join(hostRoot, 'marker.txt')
      const result = await driver.run(
        `printf changed > ${JSON.stringify(markerPath)}`,
        workdir,
        30_000,
        { workspaceMount },
      )

      expect(result.exitCode).toBe(0)
      expect(await readFile(path.join(hostRoot, 'marker.txt'), 'utf8')).toBe('host\n')
      expect(await readFile(path.join(mirrorRoot, 'marker.txt'), 'utf8')).toBe('changed')
    },
    DOCKER_TEST_TIMEOUT_MS,
  )

  it.skipIf(!dockerAvailable)(
    'keeps the host workspace unchanged when parent traversal resolves inside the mirror',
    async () => {
      const hostRoot = canonicalPath(await mkdtemp(path.join(os.tmpdir(), 'belay-host-parent-')))
      const mirrorRoot = canonicalPath(
        await mkdtemp(path.join(os.tmpdir(), 'belay-mirror-parent-')),
      )
      await mkdir(path.join(hostRoot, 'src'), { recursive: true })
      await mkdir(path.join(mirrorRoot, 'src'), { recursive: true })
      await writeFile(path.join(hostRoot, 'src', 'file.txt'), 'host\n')
      await writeFile(path.join(mirrorRoot, 'src', 'file.txt'), 'mirror\n')

      const workspaceMount = {
        hostSourceRoot: mirrorRoot,
        guestTargetRoot: hostRoot,
        cwdRelative: 'src',
        writable: true,
        hideHostSourcePath: true,
      }
      const driver = createContainerBoundaryDriver({ repoRoot: hostRoot })
      const workdir = resolveGuestWorkdir(workspaceMount)
      const result = await driver.run('cd .. && printf parent > marker.txt', workdir, 30_000, {
        workspaceMount,
      })

      expect(result.exitCode).toBe(0)
      expect(await readFile(path.join(hostRoot, 'src', 'file.txt'), 'utf8')).toBe('host\n')
      expect(await pathExists(path.join(hostRoot, 'marker.txt'))).toBe(false)
      expect(await readFile(path.join(mirrorRoot, 'marker.txt'), 'utf8')).toBe('parent')
    },
    DOCKER_TEST_TIMEOUT_MS,
  )

  it.skipIf(!dockerAvailable)(
    'keeps the host workspace unchanged when OLDPWD resolves inside the mirror',
    async () => {
      const hostRoot = canonicalPath(await mkdtemp(path.join(os.tmpdir(), 'belay-host-oldpwd-')))
      const mirrorRoot = canonicalPath(
        await mkdtemp(path.join(os.tmpdir(), 'belay-mirror-oldpwd-')),
      )
      await mkdir(path.join(hostRoot, 'src'), { recursive: true })
      await mkdir(path.join(mirrorRoot, 'src'), { recursive: true })
      await writeFile(path.join(hostRoot, 'src', 'file.txt'), 'host\n')
      await writeFile(path.join(mirrorRoot, 'src', 'file.txt'), 'mirror\n')

      const workspaceMount = {
        hostSourceRoot: mirrorRoot,
        guestTargetRoot: hostRoot,
        cwdRelative: 'src',
        writable: true,
        hideHostSourcePath: true,
      }
      const driver = createContainerBoundaryDriver({ repoRoot: hostRoot })
      const workdir = resolveGuestWorkdir(workspaceMount)
      const result = await driver.run(
        'printf oldpwd > "$OLDPWD/marker-oldpwd.txt"',
        workdir,
        30_000,
        { workspaceMount },
      )

      expect(result.exitCode).toBe(0)
      expect(await readFile(path.join(hostRoot, 'src', 'file.txt'), 'utf8')).toBe('host\n')
      expect(await pathExists(path.join(hostRoot, 'marker-oldpwd.txt'))).toBe(false)
      expect(await readFile(path.join(mirrorRoot, 'src', 'marker-oldpwd.txt'), 'utf8')).toBe(
        'oldpwd',
      )
    },
    DOCKER_TEST_TIMEOUT_MS,
  )

  it('attests workspace mount isolation on probe', async () => {
    if (!dockerAvailable) {
      return
    }
    const driver = createContainerBoundaryDriver()
    const attestation = await driver.probe()
    expect(attestation.isolatesWorkspaceMounts).toBe(true)
    expect(attestation.probeSignals).toContain('workspace-mount-isolation')
  })
})
