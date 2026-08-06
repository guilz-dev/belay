export const BOUNDARY_ATTESTATION_VERSION = 1 as const

export type BoundaryDriverId =
  | 'container'
  | 'cursor-sandbox'
  | 'seatbelt'
  | 'landlock'
  | 'host-integration'

export interface BoundaryAttestation {
  version: typeof BOUNDARY_ATTESTATION_VERSION
  driver: BoundaryDriverId
  probedAt: string
  expiresAt: string
  deniesUngrantedEffects: boolean
  materializesGrants: boolean
  probeSignals: string[]
}

export function isAttestationFresh(attestation: BoundaryAttestation, now = Date.now()): boolean {
  const expires = Date.parse(attestation.expiresAt)
  if (!Number.isFinite(expires)) {
    return false
  }
  if (expires <= now) {
    return false
  }
  if (attestation.driver === 'host-integration') {
    return true
  }
  return attestation.deniesUngrantedEffects
}
