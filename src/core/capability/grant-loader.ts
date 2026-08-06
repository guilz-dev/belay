import type { BelayConfigV4 } from '../config.js'
import type { ApprovalStateFile, ClassifierOptions } from '../types.js'
import type { BoundaryAttestation } from './attestation.js'
import { type BoundaryProfileId, resolveBoundaryProfile } from './boundary-profile.js'
import { boundaryAttestationPath, loadBoundaryAttestation } from './boundary-session.js'
import type { CapabilityGrantV1 } from './grant.js'
import { grantsFromApprovedState } from './grant-lease.js'

export function capabilityGrantsEnabled(config: BelayConfigV4): boolean {
  return config.capability?.grantsEnabled !== false
}

export function grantsFromApprovalState(
  state: ApprovalStateFile,
  repoRoot: string,
  config: BelayConfigV4,
): CapabilityGrantV1[] | undefined {
  if (!capabilityGrantsEnabled(config)) {
    return undefined
  }
  const grants = grantsFromApprovedState(state, repoRoot)
  return grants.length > 0 ? grants : undefined
}

export async function loadClassifierAuthorization(params: {
  repoRoot: string
  config: BelayConfigV4
  approvedState: ApprovalStateFile
}): Promise<Pick<ClassifierOptions, 'grants' | 'attestation' | 'boundaryProfile'>> {
  const grants = grantsFromApprovalState(params.approvedState, params.repoRoot, params.config)
  const attestation = await loadBoundaryAttestation(
    boundaryAttestationPath(params.repoRoot, params.config),
  )
  const boundaryProfile: BoundaryProfileId = resolveBoundaryProfile({
    config: params.config,
    attestation,
  })
  return { grants, attestation, boundaryProfile }
}

export type { BoundaryAttestation, CapabilityGrantV1 }
