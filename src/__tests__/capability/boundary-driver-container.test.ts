import { mkdtemp } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import {
  createContainerBoundaryDriver,
  isDockerAvailable,
} from '../../core/capability/boundary-driver-container.js'

const dockerAvailable = await isDockerAvailable()
const DOCKER_TEST_TIMEOUT_MS = 60_000

describe('container boundary driver', () => {
  it.skipIf(!dockerAvailable)(
    'probes docker when available',
    async () => {
      const driver = createContainerBoundaryDriver()
      const attestation = await driver.probe()
      expect(attestation.driver).toBe('container')
      expect(attestation.materializesGrants).toBe(false)
      expect(attestation.deniesUngrantedEffects).toBe(false)
      expect(attestation.isolatesWorkspaceMounts).toBe(true)
    },
    DOCKER_TEST_TIMEOUT_MS,
  )

  it.skipIf(!dockerAvailable)(
    'runs a command in an isolated container',
    async () => {
      const driver = createContainerBoundaryDriver()
      const cwd = process.cwd()
      const result = await driver.run('echo belay-container-ok', cwd, 30_000)
      expect(result.timedOut).toBe(false)
      expect(result.exitCode).toBe(0)
    },
    DOCKER_TEST_TIMEOUT_MS,
  )

  it.skipIf(!dockerAvailable)(
    'blocks writes on read-only mounts and allows them on read-write mounts',
    async () => {
      const driver = createContainerBoundaryDriver()
      const cwd = await mkdtemp(path.join(os.tmpdir(), 'belay-container-mount-'))

      const readOnly = await driver.run('touch write-test.txt', cwd, 30_000)
      expect(readOnly.exitCode).not.toBe(0)

      const readWrite = await driver.run('touch write-test.txt', cwd, 30_000, {
        mountReadOnly: false,
      })
      expect(readWrite.exitCode).toBe(0)
    },
    DOCKER_TEST_TIMEOUT_MS,
  )

  it(
    'routes network through egress proxy env when configured',
    async () => {
      const driver = createContainerBoundaryDriver({
        egressProxyEnv: {
          HTTP_PROXY: 'http://127.0.0.1:17831',
          HTTPS_PROXY: 'http://127.0.0.1:17831',
        },
      })
      const attestation = await driver.probe().catch(() => null)
      if (!attestation) {
        return
      }
      expect(attestation.probeSignals).toContain('egress-proxy-chokepoint')
    },
    DOCKER_TEST_TIMEOUT_MS,
  )

  it('materializes scoped grants for repo-local paths', () => {
    const driver = createContainerBoundaryDriver()
    const repoRoot = process.cwd()
    const request = {
      version: 1 as const,
      principal: { repoRoot, sessionHash: 'sess' },
      action: 'fs.write' as const,
      resource: { kind: 'path' as const, path: `${repoRoot}/notes.txt` },
      context: {
        cwd: repoRoot,
        inputFingerprint: 'fp',
        hookKind: 'shell' as const,
        analysisBasis: ['location:repo_local'],
      },
      evidence: { level: 'certain' as const, signals: [] },
    }
    const attestation = {
      version: 1 as const,
      driver: 'container' as const,
      probedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      deniesUngrantedEffects: true,
      materializesGrants: true,
      probeSignals: ['docker', 'repo-mount-ro-default'],
    }
    const grant = driver.materializeGrant(request, {
      attestation,
      mountRoot: repoRoot,
      egressProxyActive: false,
    })
    expect(grant?.issuer).toBe('boundary:container')
  })
})
