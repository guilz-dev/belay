import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { egressStatus } from '../../services/egress-service.js'
import type { BelayConfigV4 } from '../config.js'
import type { BoundaryAttestation, BoundaryDriverId } from './attestation.js'
import { getDefaultBoundaryDriver } from './boundary-driver.js'
import { egressProxyEnvFromConfig, isEgressProxyActive } from './boundary-egress.js'

export interface BoundarySessionOptions {
  egressProxyRunning?: boolean
}

export function boundaryAttestationPath(repoRoot: string, config: BelayConfigV4): string {
  const rel = config.capability?.attestationRelPath ?? '.belay/attestation.json'
  return path.isAbsolute(rel) ? rel : path.join(repoRoot, rel)
}

export async function loadBoundaryAttestation(
  filePath: string,
): Promise<BoundaryAttestation | null> {
  try {
    const raw = JSON.parse(await readFile(filePath, 'utf8')) as BoundaryAttestation
    if (raw.version !== 1 || typeof raw.driver !== 'string') {
      return null
    }
    return raw
  } catch {
    return null
  }
}

export async function saveBoundaryAttestation(
  filePath: string,
  attestation: BoundaryAttestation,
): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 })
  await writeFile(filePath, `${JSON.stringify(attestation, null, 2)}\n`, {
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
  const proxyEnv = egressProxyEnvFromConfig(params.config, proxyActive)
  const driver = getDefaultBoundaryDriver(driverId, { egressProxyEnv: proxyEnv })
  const attestation = await driver.probe()
  const attestationPath = boundaryAttestationPath(params.repoRoot, params.config)
  await saveBoundaryAttestation(attestationPath, attestation)
  return { attestation, attestationPath }
}

export async function boundarySessionStatus(params: {
  repoRoot: string
  config: BelayConfigV4
}): Promise<{ attestationPath: string; attestation: BoundaryAttestation | null; fresh: boolean }> {
  const attestationPath = boundaryAttestationPath(params.repoRoot, params.config)
  const attestation = await loadBoundaryAttestation(attestationPath)
  const { isAttestationFresh } = await import('./attestation.js')
  return {
    attestationPath,
    attestation,
    fresh: attestation ? isAttestationFresh(attestation) : false,
  }
}
