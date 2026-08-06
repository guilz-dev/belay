import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import {
  createContainerBoundaryDriver,
  isDockerAvailable,
} from '../../core/capability/boundary-driver-container.js'
import {
  belayContainerNetworkName,
  isBelayContainerNetworkReady,
} from '../../core/capability/boundary-egress.js'

const dockerAvailable = await isDockerAvailable()

describe('container boundary isolation', () => {
  it.skipIf(!dockerAvailable)(
    'blocks writes on read-only mounts inside the working directory',
    async () => {
      const driver = createContainerBoundaryDriver()
      const cwd = await mkdtemp(path.join(os.tmpdir(), 'belay-container-ro-mount-'))

      const result = await driver.run('touch blocked-in-mount.txt', cwd, 30_000)
      expect(result.exitCode).not.toBe(0)
    },
  )

  it.skipIf(!dockerAvailable)('blocks control-plane writes on read-only mounts', async () => {
    const driver = createContainerBoundaryDriver()
    const cwd = await mkdtemp(path.join(os.tmpdir(), 'belay-container-cp-'))
    await mkdir(path.join(cwd, '.cursor'), { recursive: true })
    await writeFile(path.join(cwd, '.cursor', 'belay.config.json'), '{}')

    const result = await driver.run('echo x >> .cursor/belay.config.json', cwd, 30_000)
    expect(result.exitCode).not.toBe(0)
  })

  it.skipIf(!dockerAvailable)(
    'does not inject ambient host credentials into the container',
    async () => {
      const driver = createContainerBoundaryDriver()
      const cwd = process.cwd()

      const result = await driver.run(
        'test -z "$AWS_SECRET_ACCESS_KEY" && test -z "$GITHUB_TOKEN"',
        cwd,
        30_000,
      )
      expect(result.exitCode).toBe(0)
    },
  )

  it.skipIf(!dockerAvailable)(
    'blocks direct network when egress proxy is not configured',
    async () => {
      const driver = createContainerBoundaryDriver()
      const cwd = process.cwd()

      const result = await driver.run(
        'wget -q --spider --timeout=2 https://example.com',
        cwd,
        10_000,
      )
      expect(result.exitCode).not.toBe(0)
    },
    20_000,
  )

  it.skipIf(!dockerAvailable)(
    'prepare creates container network when egress proxy is active',
    async () => {
      const repoRoot = await mkdtemp(path.join(os.tmpdir(), 'belay-container-net-'))
      const driver = createContainerBoundaryDriver({
        egressProxyEnv: { HTTP_PROXY: 'http://127.0.0.1:17831' },
        repoRoot,
      })

      await driver.prepare?.({
        repoRoot,
        egressProxyActive: true,
        proxyEnv: { HTTP_PROXY: 'http://127.0.0.1:17831' },
      })

      expect(await isBelayContainerNetworkReady(repoRoot)).toBe(true)
      expect(belayContainerNetworkName(repoRoot)).toMatch(/^belay-int-/)
    },
  )
})
