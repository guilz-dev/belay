import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { egressStatus } from '../../services/egress-service.js'
import type { BelayConfigV4 } from '../config.js'
import { configuredControlPlaneDir } from '../config.js'
import {
  type ContainedDockerDependencies,
  probeContainedDockerForSession,
} from '../contained-execution/docker.js'
import type { BoundaryAttestation, BoundaryDriverId } from './attestation.js'
import { isAttestationFresh } from './attestation.js'
import {
  readSignedAttestationFile,
  signBoundaryAttestation,
  verifySignedBoundaryAttestation,
} from './boundary-attestation-sign.js'
import { type BoundaryDriver, getDefaultBoundaryDriver } from './boundary-driver.js'
import {
  dockerNetworkArgs,
  isEgressProxyActive,
  resolveBoundaryEgressProxyEnv,
} from './boundary-egress.js'
import {
  type BoundaryPrepareContext,
  type BoundaryRunOptions,
  runWithBoundaryRunnable,
} from './boundary-run.js'

export interface BoundarySessionOptions {
  egressProxyRunning?: boolean
}

export interface ResolvedBoundaryDriverContext {
  driver: BoundaryDriver
  driverId: BoundaryDriverId
  proxyActive: boolean
  proxyEnv: Record<string, string>
  prepareContext: BoundaryPrepareContext
  attestationPath: string
  attestation: BoundaryAttestation | null
  attestationFresh: boolean
}

export function boundaryAttestationPath(repoRoot: string, config: BelayConfigV4): string {
  const rel = config.capability?.attestationRelPath ?? '.belay/attestation.json'
  return path.isAbsolute(rel) ? rel : path.join(repoRoot, rel)
}

export async function loadBoundaryAttestation(
  filePath: string,
  expectedRepoRoot?: string,
  controlPlaneDir?: string,
): Promise<BoundaryAttestation | null> {
  try {
    const raw = await readSignedAttestationFile(filePath)
    if (expectedRepoRoot && controlPlaneDir) {
      return verifySignedBoundaryAttestation({
        file: raw,
        expectedRepoRoot,
        controlPlaneDir,
      })
    }
    return null
  } catch {
    return null
  }
}

export async function saveBoundaryAttestation(
  filePath: string,
  attestation: BoundaryAttestation,
  repoRoot: string,
  controlPlaneDir: string,
): Promise<void> {
  const signed = await signBoundaryAttestation({
    repoRoot,
    attestation,
    controlPlaneDir,
  })
  await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 })
  await writeFile(filePath, `${JSON.stringify(signed, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  })
}

export function hostIntegrationBoundaryContext(repoRoot: string): ResolvedBoundaryDriverContext {
  const driver = getDefaultBoundaryDriver('host-integration', { repoRoot })
  return {
    driver,
    driverId: 'host-integration',
    proxyActive: false,
    proxyEnv: {},
    prepareContext: {
      repoRoot,
      egressProxyActive: false,
      proxyEnv: {},
    },
    attestationPath: '',
    attestation: null,
    attestationFresh: false,
  }
}

export async function resolveBoundaryDriverContext(params: {
  repoRoot: string
  config: BelayConfigV4
  driverId?: BoundaryDriverId
  egressProxyRunning?: boolean
}): Promise<ResolvedBoundaryDriverContext> {
  const driverId = params.driverId ?? params.config.capability?.boundaryDriver ?? 'host-integration'
  let proxyActive = params.egressProxyRunning === true
  if (params.egressProxyRunning === undefined) {
    const egress = await egressStatus({ targetDir: params.repoRoot })
    proxyActive = isEgressProxyActive({
      config: params.config,
      running: egress.running,
      foreignProxy: egress.foreignProxy,
      repoRootMismatch: egress.repoRootMismatch,
    })
  }
  const proxyEnv = resolveBoundaryEgressProxyEnv({
    driverId,
    config: params.config,
    proxyActive,
  })
  const driver = getDefaultBoundaryDriver(driverId, {
    egressProxyEnv: proxyEnv,
    repoRoot: params.repoRoot,
  })
  const attestationPath = boundaryAttestationPath(params.repoRoot, params.config)
  const attestation = await loadBoundaryAttestation(
    attestationPath,
    params.repoRoot,
    configuredControlPlaneDir(params.config),
  )
  return {
    driver,
    driverId,
    proxyActive,
    proxyEnv,
    prepareContext: {
      repoRoot: params.repoRoot,
      egressProxyActive: proxyActive,
      proxyEnv,
    },
    attestationPath,
    attestation,
    attestationFresh: attestation ? isAttestationFresh(attestation) : false,
  }
}

export async function runWithBoundaryDriver(params: {
  context: ResolvedBoundaryDriverContext
  command: string
  cwd: string
  timeoutMs: number
  runOptions?: BoundaryRunOptions
}): Promise<Awaited<ReturnType<BoundaryDriver['run']>>> {
  return runWithBoundaryRunnable(params.context.driver, {
    prepareContext: params.context.prepareContext,
    command: params.command,
    cwd: params.cwd,
    timeoutMs: params.timeoutMs,
    runOptions: params.runOptions,
  })
}

export async function startBoundarySession(params: {
  repoRoot: string
  config: BelayConfigV4
  driverId?: BoundaryDriverId
  egressProxyRunning?: boolean
  containedDockerDependencies?: ContainedDockerDependencies
}): Promise<{ attestation: BoundaryAttestation; attestationPath: string }> {
  const contained = params.config.sandbox.containedExecution
  if (contained?.enabled === true) {
    const attestation = await probeContainedDockerForSession({
      repoRoot: params.repoRoot,
      config: contained,
      dependencies: params.containedDockerDependencies,
    })
    const attestationPath = boundaryAttestationPath(params.repoRoot, params.config)
    await saveBoundaryAttestation(
      attestationPath,
      attestation,
      params.repoRoot,
      configuredControlPlaneDir(params.config),
    )
    return { attestation, attestationPath }
  }
  const resolved = await resolveBoundaryDriverContext(params)
  const attestation = await resolved.driver.probe()
  if (resolved.driver.prepare) {
    await resolved.driver.prepare(resolved.prepareContext)
  }
  const attestationPath = boundaryAttestationPath(params.repoRoot, params.config)
  await saveBoundaryAttestation(
    attestationPath,
    attestation,
    params.repoRoot,
    configuredControlPlaneDir(params.config),
  )
  return { attestation, attestationPath }
}

export async function boundarySessionStatus(params: {
  repoRoot: string
  config: BelayConfigV4
}): Promise<{ attestationPath: string; attestation: BoundaryAttestation | null; fresh: boolean }> {
  const attestationPath = boundaryAttestationPath(params.repoRoot, params.config)
  const attestation = await loadBoundaryAttestation(
    attestationPath,
    params.repoRoot,
    configuredControlPlaneDir(params.config),
  )
  return {
    attestationPath,
    attestation,
    fresh: attestation ? isAttestationFresh(attestation) : false,
  }
}

export async function runBoundaryAgentCommand(params: {
  repoRoot: string
  config: BelayConfigV4
  command: string
  cwd?: string
  timeoutMs?: number
  runOptions?: BoundaryRunOptions
}): Promise<Awaited<ReturnType<BoundaryDriver['run']>>> {
  const context = await resolveBoundaryDriverContext({
    repoRoot: params.repoRoot,
    config: params.config,
  })
  return runWithBoundaryDriver({
    context,
    command: params.command,
    cwd: params.cwd ?? params.repoRoot,
    timeoutMs: params.timeoutMs ?? 30 * 60_000,
    runOptions: params.runOptions,
  })
}

export { dockerNetworkArgs }
