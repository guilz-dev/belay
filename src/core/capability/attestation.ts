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

const KNOWN_DRIVERS = new Set<BoundaryDriverId>([
  'container',
  'cursor-sandbox',
  'seatbelt',
  'landlock',
  'host-integration',
])

export function validateBoundaryAttestation(value: unknown): value is BoundaryAttestation {
  if (!value || typeof value !== 'object') {
    return false
  }
  const record = value as BoundaryAttestation
  if (record.version !== BOUNDARY_ATTESTATION_VERSION) {
    return false
  }
  if (!KNOWN_DRIVERS.has(record.driver)) {
    return false
  }
  if (typeof record.probedAt !== 'string' || typeof record.expiresAt !== 'string') {
    return false
  }
  if (typeof record.deniesUngrantedEffects !== 'boolean') {
    return false
  }
  if (typeof record.materializesGrants !== 'boolean') {
    return false
  }
  if (
    !Array.isArray(record.probeSignals) ||
    !record.probeSignals.every((s) => typeof s === 'string')
  ) {
    return false
  }
  if (record.driver === 'host-integration' && record.materializesGrants) {
    return false
  }
  if (
    record.driver === 'container' &&
    record.materializesGrants &&
    !record.deniesUngrantedEffects
  ) {
    return false
  }
  return true
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
