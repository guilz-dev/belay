import { spawn } from 'node:child_process'

import { canonicalPath } from '../path-utils.js'
import type { ShellRunResult } from '../transactional/git-worktree.js'
import type { BoundaryAttestation } from './attestation.js'
import type { BoundaryDriver, BoundaryMaterializeContext } from './boundary-driver.js'
import { dockerEnvArgs, dockerNetworkArgs, ensureBelayContainerNetwork } from './boundary-egress.js'
import { materializeContainerBoundaryGrant } from './boundary-grant-materialize.js'
import type { BoundaryRunOptions } from './boundary-run.js'

const ATTESTATION_TTL_MS = 15 * 60_000
const DEFAULT_IMAGE = 'alpine:3.20'

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

function runInContainer(
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
  const proxyActive = Object.keys(proxyEnv).length > 0
  const networkArgs = dockerNetworkArgs(proxyActive, repoRoot)
  const args = [
    'run',
    '--rm',
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
  return new Promise((resolve) => {
    const child = spawn('docker', args, { stdio: 'ignore' })
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGTERM')
    }, timeoutMs)
    child.on('error', () => {
      clearTimeout(timer)
      resolve({ exitCode: 1, signal: null, timedOut })
    })
    child.on('close', (exitCode, signal) => {
      clearTimeout(timer)
      resolve({
        exitCode,
        signal: signal ? String(signal) : null,
        timedOut,
      })
    })
  })
}

export function createContainerBoundaryDriver(
  options: { image?: string; egressProxyEnv?: Record<string, string>; repoRoot?: string } = {},
): BoundaryDriver {
  const image = options.image ?? DEFAULT_IMAGE
  const proxyEnv = options.egressProxyEnv ?? {}
  const repoRoot = options.repoRoot
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
    async run(command, cwd, timeoutMs, options?: BoundaryRunOptions) {
      const mountReadOnly = options?.mountReadOnly !== false
      const proxyActive = Object.keys(proxyEnv).length > 0
      if (proxyActive && repoRoot) {
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
