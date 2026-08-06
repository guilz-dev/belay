import type { BelayConfigV4 } from '../config.js'
import type { BoundaryAttestation } from './attestation.js'
import { isAttestationFresh } from './attestation.js'

/** Policy-only boundary (L3/L4). No attested L1 enforcement. */
export const BOUNDARY_PROFILE_L3_POLICY = 'l3-policy-engine' as const

/** Editor-facing label when only prediction + approval layers are active. */
export const BOUNDARY_PROFILE_L3_L4_ONLY = 'l3-l4-only' as const

/** Attested container / sandbox boundary with grant materialization. */
export const BOUNDARY_PROFILE_L1_ATTESTED = 'l1-attested-boundary' as const

export type BoundaryProfileId =
  | typeof BOUNDARY_PROFILE_L3_POLICY
  | typeof BOUNDARY_PROFILE_L3_L4_ONLY
  | typeof BOUNDARY_PROFILE_L1_ATTESTED

export function isAttestedBoundary(attestation: BoundaryAttestation | null | undefined): boolean {
  if (!attestation || !isAttestationFresh(attestation)) {
    return false
  }
  return attestation.deniesUngrantedEffects && attestation.materializesGrants
}

export function resolveBoundaryProfile(params: {
  config: BelayConfigV4
  attestation?: BoundaryAttestation | null
}): BoundaryProfileId {
  if (!isAttestedBoundary(params.attestation)) {
    return BOUNDARY_PROFILE_L3_L4_ONLY
  }
  if (params.attestation?.driver === 'container') {
    return BOUNDARY_PROFILE_L1_ATTESTED
  }
  return BOUNDARY_PROFILE_L3_POLICY
}

export function boundaryVerifiedAllowEnabled(
  attestation: BoundaryAttestation | null | undefined,
): boolean {
  return isAttestedBoundary(attestation)
}
