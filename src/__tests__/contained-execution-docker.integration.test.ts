import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { lstat, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'

import { afterAll, describe, expect, it } from 'vitest'

import { CONTAINED_UNKNOWN_EXECUTION_GUARANTEE } from '../conformance/contained-execution-guarantee.js'
import { signBoundaryAttestation } from '../core/capability/boundary-attestation-sign.js'
import { DEFAULT_CONFIG_V3, normalizeConfig } from '../core/config.js'
import {
  buildContainedDockerCreateArgs,
  executeContainedDocker,
  probeContainedDockerBoundary,
  probeContainedDockerForSession,
} from '../core/contained-execution/docker.js'
import {
  type ContainedExecutionMirrorHandle,
  validateContainedExecutionMirrorLease,
  withContainedExecutionMirror,
} from '../core/contained-execution/mirror.js'

const execFileAsync = promisify(execFile)
const imageReference = 'alpine:3.20'
const dockerExecutable = process.env.BELAY_TEST_DOCKER_EXECUTABLE ?? '/usr/local/bin/docker'
const dockerHost = process.env.BELAY_TEST_DOCKER_HOST ?? 'unix:///var/run/docker.sock'
const dockerEnvironment = {
  DOCKER_CONFIG: '/var/empty/belay-docker-config',
  HOME: '/var/empty',
  LC_ALL: 'C',
  PATH: '/usr/bin:/bin',
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`
}

async function assertContainerAbsent(containerId: string): Promise<void> {
  await execFileAsync(dockerExecutable, ['--host', dockerHost, 'rm', '-f', containerId], {
    env: dockerEnvironment,
  })
  await expect(
    execFileAsync(dockerExecutable, ['--host', dockerHost, 'inspect', containerId], {
      env: dockerEnvironment,
    }),
  ).rejects.toThrow()
}

async function containedContainerIds(): Promise<string[]> {
  const listed = await execFileAsync(
    dockerExecutable,
    ['--host', dockerHost, 'ps', '-a', '--filter', 'name=belay-contained-', '--format', '{{.ID}}'],
    { env: dockerEnvironment },
  )
  return listed.stdout.split('\n').filter(Boolean).sort()
}

async function pathIsAbsent(target: string): Promise<boolean> {
  try {
    await lstat(target)
    return false
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT'
  }
}
let localImageAvailable = false
if (dockerHost.startsWith('unix:///')) {
  try {
    await execFileAsync(
      dockerExecutable,
      ['--host', dockerHost, 'image', 'inspect', imageReference],
      { env: dockerEnvironment },
    )
    localImageAvailable = true
  } catch {
    // The probe must never pull. Integration coverage skips without a pre-provisioned image.
  }
}

describe('contained Docker inspect integration', () => {
  const roots: string[] = []

  afterAll(async () => {
    await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })))
  })

  it.skipIf(!localImageAvailable)(
    'accepts an actual Docker container only after inspecting every isolation property',
    async () => {
      const parent = await mkdtemp(path.join(os.tmpdir(), 'belay-contained-integration-'))
      roots.push(parent)
      const mirror = path.join(parent, 'mirror')
      await mkdir(mirror)
      const beforeContainers = await containedContainerIds()

      const capability = await probeContainedDockerBoundary({
        repoRoot: parent,
        protectedRoots: [],
        imageReference,
        dockerExecutable,
        dockerHost,
        hostProbeRoot: mirror,
        guestWorkspacePath: '/workspace/belay-contained-probe',
        resourceLimits: {
          timeoutMs: 10_000,
          memoryMiB: 128,
          cpus: 0.5,
          pids: 32,
        },
      })

      expect(capability).toMatchObject({
        imageId: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
        networkNone: true,
        readOnlyRoot: true,
        capDropAll: true,
        noNewPrivileges: true,
        proxyEnvironment: 'neutralized-empty',
        tmpfs: { exec: false, mode: 0o1777, sizeBytes: 67_108_864 },
      })
      expect(await containedContainerIds()).toEqual(beforeContainers)
    },
    60_000,
  )

  it.skipIf(!localImageAvailable)(
    'executes the production mirror, signed attestation, and Docker path without host exposure',
    async () => {
      const repoRoot = await mkdtemp(path.join(os.tmpdir(), 'belay-contained-production-'))
      const unrelatedHostPath = await mkdtemp(path.join(os.tmpdir(), 'belay-contained-unrelated-'))
      roots.push(repoRoot, unrelatedHostPath)
      const controlPlaneDir = path.join(repoRoot, '.belay-control')
      const sourceSecretRoot = path.join(repoRoot, 'source-secret-root')
      const originalSourceSentinel = path.join(sourceSecretRoot, 'source-secret')
      const controlPlaneSentinel = path.join(controlPlaneDir, 'control-secret')
      const unrelatedSentinel = path.join(unrelatedHostPath, 'unrelated-secret')
      await Promise.all([mkdir(sourceSecretRoot), mkdir(controlPlaneDir)])
      await Promise.all([
        writeFile(path.join(repoRoot, 'current-state-marker'), 'visible-in-mirror'),
        writeFile(originalSourceSentinel, 'source-private'),
        writeFile(controlPlaneSentinel, 'control-private'),
        writeFile(unrelatedSentinel, 'unrelated-private'),
      ])
      const config = normalizeConfig({
        ...DEFAULT_CONFIG_V3,
        sandbox: {
          enabled: true,
          runtime: 'container',
          denyNetworkByDefault: true,
          containedExecution: {
            enabled: true,
            image: imageReference,
            dockerExecutable,
            dockerHost,
            timeoutMs: 10_000,
            memoryMiB: 128,
            cpus: 0.5,
            pids: 32,
          },
        },
      })
      const containedConfig = config.sandbox.containedExecution
      if (!containedConfig) throw new Error('expected contained execution config')
      const attestation = await probeContainedDockerForSession({
        repoRoot,
        controlPlaneDir,
        config: containedConfig,
      })
      const signedAttestation = await signBoundaryAttestation({
        repoRoot,
        controlPlaneDir,
        attestation,
      })
      expect(attestation).toMatchObject({
        deniesUngrantedEffects: CONTAINED_UNKNOWN_EXECUTION_GUARANTEE.deniesUngrantedEffects,
        materializesGrants: CONTAINED_UNKNOWN_EXECUTION_GUARANTEE.materializesGrants,
        containedExecution: {
          networkNone: CONTAINED_UNKNOWN_EXECUTION_GUARANTEE.boundary.network === 'none',
          readOnlyRoot: CONTAINED_UNKNOWN_EXECUTION_GUARANTEE.boundary.readOnlyRoot,
          sanitizedEnvironment:
            CONTAINED_UNKNOWN_EXECUTION_GUARANTEE.boundary.sanitizedHostEnvironment,
          logDriver: CONTAINED_UNKNOWN_EXECUTION_GUARANTEE.boundary.logDriver,
        },
      })
      const beforeContainers = await containedContainerIds()
      const command = [
        `test -f ${shellQuote(path.join(repoRoot, 'current-state-marker'))}`,
        `test ! -e ${shellQuote(originalSourceSentinel)}`,
        `test ! -e ${shellQuote(controlPlaneSentinel)}`,
        `test ! -e ${shellQuote(unrelatedSentinel)}`,
        '! wget -q -T 2 -O - http://1.1.1.1',
        'printf contained-production-ok',
      ].join(' && ')
      let mirror: ContainedExecutionMirrorHandle | undefined
      const execution = await withContainedExecutionMirror(
        {
          sourceRoot: repoRoot,
          controlPlaneRoots: [controlPlaneDir, sourceSecretRoot],
          limits: {
            maxFiles: 100,
            maxSourceBytes: 1_000_000,
            maxWorkspaceBytes: 1_000_000,
            prepareTimeoutMs: 10_000,
          },
        },
        async (prepared) => {
          mirror = prepared
          expect(
            validateContainedExecutionMirrorLease(prepared, {
              sourceRoot: repoRoot,
              protectedRoots: [controlPlaneDir, sourceSecretRoot],
            }),
          ).toBe(true)
          return executeContainedDocker({
            repoRoot,
            controlPlaneDir,
            protectedRoots: [sourceSecretRoot],
            config: containedConfig,
            mirror: prepared,
            guestCwd: repoRoot,
            command,
            inputFingerprint: 'a'.repeat(64),
            signedAttestation,
          })
        },
      )

      expect(execution.stdout).toBe('contained-production-ok')
      expect(execution.stderr).toContain('Network unreachable')
      expect(execution.receipt).toMatchObject({
        network: { mode: CONTAINED_UNKNOWN_EXECUTION_GUARANTEE.boundary.network },
        readOnlyRoot: CONTAINED_UNKNOWN_EXECUTION_GUARANTEE.boundary.readOnlyRoot,
        logging: { driver: CONTAINED_UNKNOWN_EXECUTION_GUARANTEE.boundary.logDriver },
        environment: { hostForwarded: false, proxyEnvironment: 'neutralized-empty' },
        resources: {
          memoryMiB: containedConfig.memoryMiB,
          cpus: containedConfig.cpus,
          pids: containedConfig.pids,
        },
      })
      expect(execution.receipt.mirror).toMatchObject({ backend: 'file_copy', cardinality: 1 })
      const serialized = JSON.stringify(execution)
      for (const sentinel of ['source-private', 'control-private', 'unrelated-private']) {
        expect(serialized).not.toContain(sentinel)
      }
      if (!mirror) throw new Error('expected production mirror')
      expect(await pathIsAbsent(mirror.hostMirrorRoot)).toBe(true)
      expect(
        validateContainedExecutionMirrorLease(mirror, {
          sourceRoot: repoRoot,
          protectedRoots: [controlPlaneDir, sourceSecretRoot],
        }),
      ).toBe(false)
      expect(await containedContainerIds()).toEqual(beforeContainers)
    },
    60_000,
  )

  it.skipIf(!localImageAvailable)(
    'captures attached output while disabling persistent daemon logging',
    async () => {
      const parent = await mkdtemp(path.join(os.tmpdir(), 'belay-contained-log-integration-'))
      roots.push(parent)
      const mirror = path.join(parent, 'mirror')
      await mkdir(mirror)
      const image = await execFileAsync(
        dockerExecutable,
        ['--host', dockerHost, 'image', 'inspect', '--format', '{{.Id}}', imageReference],
        { env: dockerEnvironment },
      )
      const containerName = `belay-contained-${randomUUID()}`
      let containerId = containerName
      try {
        const created = await execFileAsync(
          dockerExecutable,
          [
            '--host',
            dockerHost,
            ...buildContainedDockerCreateArgs({
              containerName,
              imageId: image.stdout.trim(),
              command: 'printf attached-output',
              hostMirrorRoot: mirror,
              guestWorkspacePath: '/workspace/belay-contained-log-probe',
              guestCwd: '/workspace/belay-contained-log-probe',
              resourceLimits: { timeoutMs: 10_000, memoryMiB: 128, cpus: 0.5, pids: 32 },
              user: `${process.getuid?.() ?? 0}:${process.getgid?.() ?? 0}`,
            }),
          ],
          { env: dockerEnvironment },
        )
        containerId = created.stdout.trim()
        const started = await execFileAsync(
          dockerExecutable,
          ['--host', dockerHost, 'start', '--attach', containerId],
          { env: dockerEnvironment },
        )
        expect(started.stdout).toBe('attached-output')
        const logging = await execFileAsync(
          dockerExecutable,
          [
            '--host',
            dockerHost,
            'inspect',
            '--format',
            '[{{json .HostConfig.LogConfig}},{{json .LogPath}}]',
            containerId,
          ],
          { env: dockerEnvironment },
        )
        expect(JSON.parse(logging.stdout)).toEqual([{ Type: 'none', Config: {} }, ''])
        await expect(
          execFileAsync(dockerExecutable, ['--host', dockerHost, 'logs', containerId], {
            env: dockerEnvironment,
          }),
        ).rejects.toThrow()
      } finally {
        await assertContainerAbsent(containerId)
      }
    },
    60_000,
  )
})
