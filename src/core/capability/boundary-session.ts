import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { egressStatus } from '../../services/egress-service.js'
import type { BelayConfigV4 } from '../config.js'
import { configuredControlPlaneDir } from '../config.js'
import type { BoundaryAttestation, BoundaryDriverId } from './attestation.js'
import { isAttestationFresh } from './attestation.js'
import {
  readSignedAttestationFile,
  signBoundaryAttestation,
  verifySignedBoundaryAttestation,
} from './boundary-attestation-sign.js'
import { getDefaultBoundaryDriver } from './boundary-driver.js'
import {
  dockerNetworkArgs,
  isEgressProxyActive,
  resolveBoundaryEgressProxyEnv,
} from './boundary-egress.js'

export interface BoundarySessionOptions {
  egressProxyRunning?: boolean
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

export async function startBoundarySession(params: {
  repoRoot: string
  config: BelayConfigV4
  driverId?: BoundaryDriverId
  egressProxyRunning?: boolean
}): Promise<{ attestation: BoundaryAttestation; attestationPath: string }> {
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
  const attestation = await driver.probe()
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
}): Promise<Awaited<ReturnType<ReturnType<typeof getDefaultBoundaryDriver>['run']>>> {
  const driverId = params.config.capability?.boundaryDriver ?? 'host-integration'
  const egress = await egressStatus({ targetDir: params.repoRoot })
  const proxyActive = isEgressProxyActive({
    config: params.config,
    running: egress.running,
    foreignProxy: egress.foreignProxy,
    repoRootMismatch: egress.repoRootMismatch,
  })
  const proxyEnv = resolveBoundaryEgressProxyEnv({
    driverId,
    config: params.config,
    proxyActive,
  })
  const driver = getDefaultBoundaryDriver(driverId, {
    egressProxyEnv: proxyEnv,
    repoRoot: params.repoRoot,
  })
  return driver.run(params.command, params.cwd ?? params.repoRoot, params.timeoutMs ?? 30 * 60_000)
}

export { dockerNetworkArgs }
