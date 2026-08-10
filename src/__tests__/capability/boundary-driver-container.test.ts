import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import {
  createContainerBoundaryDriver,
  isDockerAvailable,
} from '../../core/capability/boundary-driver-container.js'
import { isBoundaryCleanupError } from '../../core/capability/boundary-run.js'

const dockerAvailable = await isDockerAvailable()
const DOCKER_TEST_TIMEOUT_MS = 60_000

describe('container boundary driver', () => {
  it.skipIf(!dockerAvailable)(
    'probes docker when available',
    async () => {
      const driver = createContainerBoundaryDriver()
      const attestation = await driver.probe()
      expect(attestation.driver).toBe('container')
      expect(attestation.materializesGrants).toBe(true)
      expect(attestation.deniesUngrantedEffects).toBe(true)
    },
    DOCKER_TEST_TIMEOUT_MS,
  )

  it.skipIf(process.platform === 'win32')(
    'fails closed when a timed-out container cannot be removed',
    async () => {
      const cwd = await mkdtemp(path.join(os.tmpdir(), 'belay-container-cleanup-failure-'))
      const binDir = path.join(cwd, 'bin')
      const dockerPath = path.join(binDir, 'docker')
      await mkdir(binDir)
      await writeFile(
        dockerPath,
        [
          '#!/bin/sh',
          'if [ "$1" = "run" ]; then',
          "  trap '' TERM",
          '  sleep 30',
          'fi',
          'echo cleanup failed >&2',
          'exit 42',
        ].join('\n'),
      )
      await chmod(dockerPath, 0o755)
      const previousPath = process.env.PATH
      process.env.PATH = `${binDir}${path.delimiter}${previousPath ?? ''}`

      try {
        const driver = createContainerBoundaryDriver()
        const failure = await driver.run('true', cwd, 200).catch((error: unknown) => error)
        expect(isBoundaryCleanupError(failure)).toBe(true)
        expect(failure).toMatchObject({
          code: 'BOUNDARY_CLEANUP_UNCONFIRMED',
          resourceKind: 'container',
          executionStarted: true,
          cleanupConfirmed: false,
        })
      } finally {
        if (previousPath === undefined) {
          delete process.env.PATH
        } else {
          process.env.PATH = previousPath
        }
        await rm(cwd, { recursive: true, force: true })
      }
    },
    DOCKER_TEST_TIMEOUT_MS,
  )

  it.skipIf(process.platform === 'win32')(
    'accepts an already-absent timed-out container as cleaned up',
    async () => {
      const cwd = await mkdtemp(path.join(os.tmpdir(), 'belay-container-already-removed-'))
      const binDir = path.join(cwd, 'bin')
      const dockerPath = path.join(binDir, 'docker')
      await mkdir(binDir)
      await writeFile(
        dockerPath,
        [
          '#!/bin/sh',
          'if [ "$1" = "run" ]; then',
          "  trap '' TERM",
          '  sleep 30',
          'fi',
          'echo "Error response from daemon: No such container: $3" >&2',
          'exit 1',
        ].join('\n'),
      )
      await chmod(dockerPath, 0o755)
      const previousPath = process.env.PATH
      process.env.PATH = `${binDir}${path.delimiter}${previousPath ?? ''}`

      try {
        const driver = createContainerBoundaryDriver()
        await expect(driver.run('true', cwd, 200)).resolves.toMatchObject({ timedOut: true })
      } finally {
        if (previousPath === undefined) {
          delete process.env.PATH
        } else {
          process.env.PATH = previousPath
        }
        await rm(cwd, { recursive: true, force: true })
      }
    },
    DOCKER_TEST_TIMEOUT_MS,
  )

  it.skipIf(!dockerAvailable)(
    'captures command output in an isolated container',
    async () => {
      const driver = createContainerBoundaryDriver()
      const cwd = process.cwd()
      const result = await driver.run(
        "printf 'belay-container-out'; printf 'belay-container-error' >&2; exit 7",
        cwd,
        30_000,
      )
      expect(result.timedOut).toBe(false)
      expect(result.exitCode).toBe(7)
      expect(result.stdout).toBe('belay-container-out')
      expect(result.stderr).toBe('belay-container-error')
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

  it.skipIf(!dockerAvailable)(
    'removes a container whose process ignores SIGTERM after timeout',
    async () => {
      const driver = createContainerBoundaryDriver()
      const cwd = await mkdtemp(path.join(os.tmpdir(), 'belay-container-timeout-'))
      const ready = path.join(cwd, 'ready.txt')
      const marker = path.join(cwd, 'survived.txt')
      try {
        const result = await driver.run(
          "printf ready > ready.txt; trap '' TERM; sleep 6; printf survived > survived.txt",
          cwd,
          5_000,
          { mountReadOnly: false },
        )
        expect(result.timedOut).toBe(true)
        await expect(readFile(ready, 'utf8')).resolves.toBe('ready')
        await new Promise((resolve) => setTimeout(resolve, 1_500))
        await expect(readFile(marker, 'utf8')).rejects.toThrow()
      } finally {
        await rm(cwd, { recursive: true, force: true })
      }
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
