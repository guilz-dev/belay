import { runShellCommand, type ShellRunResult } from '../transactional/git-worktree.js'
import type { BoundaryAttestation, BoundaryDriverId } from './attestation.js'
import { createContainerBoundaryDriver } from './boundary-driver-container.js'
import type { BoundaryPrepareContext, BoundaryRunOptions } from './boundary-run.js'
import type { CapabilityGrantV1 } from './grant.js'
import type { CapabilityRequestV1 } from './request.js'

export type { ShellRunResult as BoundaryRunResult }

export interface BoundaryMaterializeContext {
  attestation: BoundaryAttestation
  mountRoot: string
  egressProxyActive: boolean
  existingGrants?: CapabilityGrantV1[]
  sensitivePaths?: string[]
}

export type { BoundaryRunOptions } from './boundary-run.js'
export { boundaryMountReadOnlyFromPrediction } from './boundary-run.js'

export interface BoundaryDriver {
  id: BoundaryDriverId
  probe(): Promise<BoundaryAttestation>
  prepare?(context: BoundaryPrepareContext): Promise<void>
  run(
    command: string,
    cwd: string,
    timeoutMs: number,
    options?: BoundaryRunOptions,
  ): Promise<ShellRunResult>
  materializeGrant(
    request: CapabilityRequestV1,
    context: BoundaryMaterializeContext,
  ): CapabilityGrantV1 | null
}

export interface BoundaryDriverOptions {
  egressProxyEnv?: Record<string, string>
  image?: string
  repoRoot?: string
}

const ATTESTATION_TTL_MS = 15 * 60_000

function hostIntegrationAttestation(driver: BoundaryDriverId): BoundaryAttestation {
  const probedAt = new Date().toISOString()
  return {
    version: 1,
    driver,
    probedAt,
    expiresAt: new Date(Date.now() + ATTESTATION_TTL_MS).toISOString(),
    deniesUngrantedEffects: false,
    materializesGrants: false,
    probeSignals: ['host-integration', 'l3-policy-only'],
  }
}

export function createHostIntegrationDriver(): BoundaryDriver {
  return {
    id: 'host-integration',
    async probe() {
      return hostIntegrationAttestation('host-integration')
    },
    async prepare() {
      // L3 host path has no runtime preparation.
    },
    run(command, cwd, timeoutMs) {
      return runShellCommand(command, cwd, timeoutMs)
    },
    materializeGrant() {
      return null
    },
  }
}

export function getDefaultBoundaryDriver(
  driverId: BoundaryDriverId = 'host-integration',
  options: BoundaryDriverOptions = {},
): BoundaryDriver {
  if (driverId === 'container') {
    return createContainerBoundaryDriver({
      image: options.image,
      egressProxyEnv: options.egressProxyEnv,
      repoRoot: options.repoRoot,
    })
  }
  return createHostIntegrationDriver()
}
