import { spawn } from 'node:child_process'

import { canonicalPath } from '../path-utils.js'
import type { ShellRunResult } from '../transactional/git-worktree.js'
import type { BoundaryAttestation } from './attestation.js'
import type { BoundaryDriver, BoundaryMaterializeContext } from './boundary-driver.js'
import { dockerEnvArgs, dockerNetworkArgs, ensureBelayContainerNetwork } from './boundary-egress.js'
import { materializeContainerBoundaryGrant } from './boundary-grant-materialize.js'
import type { BoundaryPrepareContext, BoundaryRunOptions } from './boundary-run.js'
import {
  buildWorkspaceMountSpec,
  resolveGuestWorkdir,
  workspaceMountEnvArgs,
} from './boundary-workspace-mount.js'

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
  const signals = [
    'docker',
    'container-driver',
    'repo-mount-ro-default',
    'workspace-mount-isolation',
  ]
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
    // Mount and network classes are isolated, but exact grants are not yet
    // passed to and enforced by the process runner.
    deniesUngrantedEffects: false,
    materializesGrants: false,
    isolatesWorkspaceMounts: true,
    probeSignals: [...signals, 'exact-grant-enforcement-unavailable'],
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

export interface ContainerRunParams {
  image: string
  command: string
  cwd: string
  proxyEnv: Record<string, string>
  mountReadOnly: boolean
  repoRoot?: string
  runOptions?: BoundaryRunOptions
}

export function buildContainerRunArgs(params: ContainerRunParams): string[] {
  const proxyActive = Object.keys(params.proxyEnv).length > 0
  const networkArgs = dockerNetworkArgs(proxyActive, params.repoRoot)
  const workspaceMount = params.runOptions?.workspaceMount

  if (workspaceMount) {
    if (!params.repoRoot) {
      throw new Error('boundary_workspace_mount_missing_resource_root')
    }
    if (canonicalPath(workspaceMount.guestTargetRoot) !== canonicalPath(params.repoRoot)) {
      throw new Error('boundary_workspace_mount_target_mismatch')
    }
    const workdir = resolveGuestWorkdir(workspaceMount)
    if (canonicalPath(params.cwd) !== workdir) {
      throw new Error('boundary_workspace_mount_cwd_mismatch')
    }
    return [
      'run',
      '--rm',
      ...networkArgs,
      '--mount',
      buildWorkspaceMountSpec(workspaceMount),
      '-w',
      workdir,
      ...workspaceMountEnvArgs(workspaceMount),
      ...dockerEnvArgs(params.proxyEnv),
      params.image,
      'sh',
      '-c',
      params.command,
    ]
  }

  const mount = canonicalPath(params.cwd)
  const mountSpec = params.mountReadOnly ? `${mount}:${mount}:ro` : `${mount}:${mount}`
  return [
    'run',
    '--rm',
    ...networkArgs,
    '-v',
    mountSpec,
    '-w',
    mount,
    ...dockerEnvArgs(params.proxyEnv),
    params.image,
    'sh',
    '-c',
    params.command,
  ]
}

function runInContainer(
  image: string,
  command: string,
  cwd: string,
  timeoutMs: number,
  proxyEnv: Record<string, string>,
  mountReadOnly: boolean,
  repoRoot?: string,
  runOptions?: BoundaryRunOptions,
): Promise<ShellRunResult> {
  const args = buildContainerRunArgs({
    image,
    command,
    cwd,
    proxyEnv,
    mountReadOnly,
    repoRoot,
    runOptions,
  })
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
      const mountReadOnly = options?.mountReadOnly !== false && !options?.workspaceMount
      const proxyActive = Object.keys(proxyEnv).length > 0
      if (proxyActive && repoRoot && !preparedNetwork) {
        await ensureBelayContainerNetwork(repoRoot)
      }
      return runInContainer(
        image,
        command,
        cwd,
        timeoutMs,
        proxyEnv,
        mountReadOnly,
        repoRoot,
        options,
      )
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
