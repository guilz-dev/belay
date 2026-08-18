export const BOUNDARY_ATTESTATION_VERSION = 1 as const
export const CONTAINED_EXECUTION_ATTESTATION_VERSION = 1 as const

export type BoundaryDriverId =
  | 'container'
  | 'cursor-sandbox'
  | 'seatbelt'
  | 'landlock'
  | 'host-integration'

export interface ContainedExecutionResourceLimits {
  timeoutMs: number
  memoryMiB: number
  cpus: number
  pids: number
}

/** A separate execution-only capability; it does not attest L1 grant enforcement. */
export interface ContainedExecutionAttestation {
  version: typeof CONTAINED_EXECUTION_ATTESTATION_VERSION
  imageId: string
  networkNone: true
  isolatesWorkspaceMirror: true
  readOnlyRoot: true
  sanitizedEnvironment: true
  resourceLimits: ContainedExecutionResourceLimits
  probedAt: string
  expiresAt: string
}

export interface BoundaryAttestation {
  version: typeof BOUNDARY_ATTESTATION_VERSION
  driver: BoundaryDriverId
  probedAt: string
  expiresAt: string
  deniesUngrantedEffects: boolean
  materializesGrants: boolean
  probeSignals: string[]
  /** When true, the driver can mount an execution mirror at the original workspace path. */
  isolatesWorkspaceMounts?: boolean
  /** Optional, execution-only proof. This must never be treated as an L1-full attestation. */
  containedExecution?: ContainedExecutionAttestation
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
  if (
    record.isolatesWorkspaceMounts !== undefined &&
    typeof record.isolatesWorkspaceMounts !== 'boolean'
  ) {
    return false
  }
  if (record.containedExecution !== undefined) {
    if (
      record.driver !== 'container' ||
      !validateContainedExecutionAttestation(record.containedExecution)
    ) {
      return false
    }
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

function hasPositiveLimit(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
}

function hasPositiveIntegerLimit(value: unknown): value is number {
  return hasPositiveLimit(value) && Number.isSafeInteger(value)
}

export function validateContainedExecutionAttestation(
  value: unknown,
): value is ContainedExecutionAttestation {
  if (!value || typeof value !== 'object') {
    return false
  }
  const record = value as ContainedExecutionAttestation
  if (
    record.version !== CONTAINED_EXECUTION_ATTESTATION_VERSION ||
    typeof record.imageId !== 'string' ||
    !/^sha256:[a-f0-9]{64}$/i.test(record.imageId) ||
    record.networkNone !== true ||
    record.isolatesWorkspaceMirror !== true ||
    record.readOnlyRoot !== true ||
    record.sanitizedEnvironment !== true ||
    typeof record.probedAt !== 'string' ||
    typeof record.expiresAt !== 'string'
  ) {
    return false
  }
  const probedAt = Date.parse(record.probedAt)
  const expiresAt = Date.parse(record.expiresAt)
  if (!Number.isFinite(probedAt) || !Number.isFinite(expiresAt) || expiresAt <= probedAt) {
    return false
  }
  const limits = record.resourceLimits
  return (
    Boolean(limits) &&
    hasPositiveIntegerLimit(limits.timeoutMs) &&
    hasPositiveIntegerLimit(limits.memoryMiB) &&
    hasPositiveLimit(limits.cpus) &&
    hasPositiveIntegerLimit(limits.pids)
  )
}

export function isContainedExecutionAttestationFresh(
  attestation: ContainedExecutionAttestation | null | undefined,
  now = Date.now(),
): boolean {
  // A contained proof must have been observed already; no clock skew is accepted.
  return (
    validateContainedExecutionAttestation(attestation) &&
    Date.parse(attestation.probedAt) <= now &&
    Date.parse(attestation.expiresAt) > now
  )
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

export function attestsWorkspaceMountIsolation(
  attestation: BoundaryAttestation | null | undefined,
): boolean {
  return attestation?.isolatesWorkspaceMounts === true
}
