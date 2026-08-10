import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'

import { canonicalPath } from '../path-utils.js'
import { runProcessWithBoundedOutput, type ShellRunResult } from '../process-runner.js'
import type { BoundaryAttestation } from './attestation.js'
import type { BoundaryDriver, BoundaryMaterializeContext } from './boundary-driver.js'
import { dockerEnvArgs, dockerNetworkArgs, ensureBelayContainerNetwork } from './boundary-egress.js'
import { materializeContainerBoundaryGrant } from './boundary-grant-materialize.js'
import {
  BoundaryCleanupError,
  type BoundaryPrepareContext,
  type BoundaryRunOptions,
} from './boundary-run.js'

const ATTESTATION_TTL_MS = 15 * 60_000
const DEFAULT_IMAGE = 'alpine:3.20'
const CONTAINER_CLEANUP_TIMEOUT_MS = 10_000
const CONTAINER_INSPECT_TIMEOUT_MS = 2_000
const CONTAINER_ABSENCE_ATTEMPTS = 10
const CONTAINER_ABSENCE_RETRY_MS = 100

function containerDoesNotExist(result: ShellRunResult): boolean {
  return /no such container/i.test(`${result.stderr ?? ''}\n${result.stdout ?? ''}`)
}

async function confirmContainerAbsent(containerName: string): Promise<boolean> {
  for (let attempt = 0; attempt < CONTAINER_ABSENCE_ATTEMPTS; attempt += 1) {
    const inspection = await runProcessWithBoundedOutput(
      'docker',
      ['inspect', '--type', 'container', containerName],
      {},
      CONTAINER_INSPECT_TIMEOUT_MS,
    )
    if (!inspection.timedOut && inspection.exitCode !== 0 && containerDoesNotExist(inspection)) {
      return true
    }
    if (inspection.timedOut || (inspection.exitCode !== 0 && !containerDoesNotExist(inspection))) {
      return false
    }
    await new Promise((resolve) => setTimeout(resolve, CONTAINER_ABSENCE_RETRY_MS))
  }
  return false
}

export async function isDockerAvailable(): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn('docker', ['info'], { stdio: 'ignore' })
    child.on('error', () => resolve(false))
    child.on('close', (code) => resolve(code === 0))
  })
}

function containerAttestation(proxyEnv: Record<string, string>): BoundaryAttestation {
  const probedAt = new Date().toISOString()
  const signals = ['docker', 'container-driver', 'repo-mount-ro-default']
  if (Object.keys(proxyEnv).length > 0) {
    signals.push('egress-proxy-chokepoint')
  } else {
    signals.push('network-none')
  }
  return {
    version: 1,
    driver: 'container',
    probedAt,
    expiresAt: new Date(Date.now() + ATTESTATION_TTL_MS).toISOString(),
    deniesUngrantedEffects: true,
    materializesGrants: true,
    probeSignals: signals,
  }
}

function runDockerProbe(image: string): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn('docker', ['run', '--rm', '--network', 'none', image, 'echo', 'ok'], {
      stdio: 'ignore',
    })
    child.on('error', () => resolve(false))
    child.on('close', (code) => resolve(code === 0))
  })
}

async function runInContainer(
  image: string,
  command: string,
  cwd: string,
  timeoutMs: number,
  proxyEnv: Record<string, string>,
  mountReadOnly: boolean,
  repoRoot?: string,
): Promise<ShellRunResult> {
  const mount = canonicalPath(cwd)
  const mountSpec = mountReadOnly ? `${mount}:${mount}:ro` : `${mount}:${mount}`
  const containerName = `belay-run-${randomUUID()}`
  const proxyActive = Object.keys(proxyEnv).length > 0
  const networkArgs = dockerNetworkArgs(proxyActive, repoRoot)
  const args = [
    'run',
    '--rm',
    '--name',
    containerName,
    ...networkArgs,
    '-v',
    mountSpec,
    '-w',
    mount,
    ...dockerEnvArgs(proxyEnv),
    image,
    'sh',
    '-c',
    command,
  ]
  const result = await runProcessWithBoundedOutput('docker', args, {}, timeoutMs)
  if (result.timedOut) {
    const cleanup = await runProcessWithBoundedOutput(
      'docker',
      ['rm', '-f', containerName],
      {},
      CONTAINER_CLEANUP_TIMEOUT_MS,
    )
    const cleanupFailed = cleanup.timedOut || cleanup.exitCode !== 0
    const absent =
      containerDoesNotExist(cleanup) ||
      (cleanupFailed && (await confirmContainerAbsent(containerName)))
    if (cleanupFailed && !absent) {
      throw new BoundaryCleanupError('container', containerName)
    }
  }
  return result
}

export function createContainerBoundaryDriver(
  options: { image?: string; egressProxyEnv?: Record<string, string>; repoRoot?: string } = {},
): BoundaryDriver {
  const image = options.image ?? DEFAULT_IMAGE
  const proxyEnv = options.egressProxyEnv ?? {}
  const repoRoot = options.repoRoot
  let preparedNetwork = false
  return {
    id: 'container',
    async probe() {
      if (!(await isDockerAvailable())) {
        throw new Error('Docker is not available for container boundary driver')
      }
      if (!(await runDockerProbe(image))) {
        throw new Error(`Docker probe failed for image ${image}`)
      }
      return containerAttestation(proxyEnv)
    },
    async prepare(context: BoundaryPrepareContext) {
      if (context.egressProxyActive && context.repoRoot) {
        await ensureBelayContainerNetwork(context.repoRoot)
        preparedNetwork = true
      }
    },
    async run(command, cwd, timeoutMs, options?: BoundaryRunOptions) {
      const mountReadOnly = options?.mountReadOnly !== false
      const proxyActive = Object.keys(proxyEnv).length > 0
      if (proxyActive && repoRoot && !preparedNetwork) {
        await ensureBelayContainerNetwork(repoRoot)
      }
      return runInContainer(image, command, cwd, timeoutMs, proxyEnv, mountReadOnly, repoRoot)
    },
    materializeGrant(request, context: BoundaryMaterializeContext) {
      return materializeContainerBoundaryGrant(request, {
        attestation: context.attestation,
        mountRoot: context.mountRoot,
        egressProxyActive: context.egressProxyActive,
        existingGrants: context.existingGrants,
        sensitivePaths: context.sensitivePaths,
      })
    },
  }
}
