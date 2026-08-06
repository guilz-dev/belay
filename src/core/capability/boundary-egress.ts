import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'

import type { BelayConfigV4 } from '../config.js'
import { recommendedProxyEnv } from '../egress/env.js'
import { canonicalPath } from '../path-utils.js'
import type { BoundaryDriverId } from './attestation.js'

export function isEgressProxyActive(params: {
  config: BelayConfigV4
  running: boolean
  foreignProxy?: boolean
  repoRootMismatch?: boolean
}): boolean {
  if (!params.config.egress.enabled) {
    return false
  }
  return params.running && !params.foreignProxy && !params.repoRootMismatch
}

function proxyHostForContainer(listenHost: string): string {
  if (listenHost === '127.0.0.1' || listenHost === 'localhost' || listenHost === '::1') {
    return 'host.docker.internal'
  }
  return listenHost
}

export function egressProxyEnvFromConfig(
  config: BelayConfigV4,
  proxyActive: boolean,
): Record<string, string> {
  if (!proxyActive || !config.egress.enabled) {
    return {}
  }
  return recommendedProxyEnv(config.egress)
}

/** Container workloads cannot reach 127.0.0.1 on the host; route via host.docker.internal. */
export function egressProxyEnvForContainer(
  config: BelayConfigV4,
  proxyActive: boolean,
): Record<string, string> {
  if (!proxyActive || !config.egress.enabled) {
    return {}
  }
  const host = proxyHostForContainer(config.egress.listenHost)
  const proxyUrl = `http://${host}:${config.egress.listenPort}`
  return {
    HTTP_PROXY: proxyUrl,
    HTTPS_PROXY: proxyUrl,
    http_proxy: proxyUrl,
    https_proxy: proxyUrl,
    NO_PROXY: '127.0.0.1,localhost',
    no_proxy: '127.0.0.1,localhost',
  }
}

export function resolveBoundaryEgressProxyEnv(params: {
  driverId: BoundaryDriverId
  config: BelayConfigV4
  proxyActive: boolean
}): Record<string, string> {
  if (params.driverId === 'container') {
    return egressProxyEnvForContainer(params.config, params.proxyActive)
  }
  return egressProxyEnvFromConfig(params.config, params.proxyActive)
}

export function belayContainerNetworkName(repoRoot: string): string {
  const hash = createHash('sha256').update(canonicalPath(repoRoot)).digest('hex').slice(0, 12)
  return `belay-int-${hash}`
}

function dockerNetworkInspect(name: string): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn('docker', ['network', 'inspect', name], { stdio: 'ignore' })
    child.on('error', () => resolve(false))
    child.on('close', (code) => resolve(code === 0))
  })
}

export async function isBelayContainerNetworkReady(repoRoot: string): Promise<boolean> {
  return dockerNetworkInspect(belayContainerNetworkName(repoRoot))
}

function dockerNetworkCreateInternal(name: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn('docker', ['network', 'create', '--internal', '--label', 'belay=1', name], {
      stdio: 'ignore',
    })
    child.on('error', reject)
    child.on('close', (code) => {
      if (code === 0) {
        resolve()
        return
      }
      reject(new Error(`Failed to create internal docker network ${name}`))
    })
  })
}

export async function ensureBelayContainerNetwork(repoRoot: string): Promise<string> {
  const name = belayContainerNetworkName(repoRoot)
  if (await dockerNetworkInspect(name)) {
    return name
  }
  try {
    await dockerNetworkCreateInternal(name)
  } catch (error) {
    if (await dockerNetworkInspect(name)) {
      return name
    }
    throw error
  }
  return name
}

export function dockerNetworkArgs(proxyActive: boolean, repoRoot?: string): string[] {
  if (!proxyActive) {
    return ['--network', 'none']
  }
  if (!repoRoot) {
    return ['--network', 'none']
  }
  return [
    '--add-host=host.docker.internal:host-gateway',
    '--network',
    belayContainerNetworkName(repoRoot),
  ]
}

export function dockerEnvArgs(proxyEnv: Record<string, string>): string[] {
  const args: string[] = []
  for (const [key, value] of Object.entries(proxyEnv)) {
    args.push('-e', `${key}=${value}`)
  }
  return args
}
