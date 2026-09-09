import { createHash } from 'node:crypto'

import type { AuditRecord, DecisionCohortIdentity } from './audit-types.js'

const HEX64_PATTERN = /^[a-f0-9]{64}$/
const ISO8601_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/

export const AUDIT_READINESS_STATE_MAX_BYTES = 4_096
export const AUDIT_READINESS_STATE_SCHEMA_VERSION = 1

export interface AuditReadinessUpdate {
  cohort: DecisionCohortIdentity
  availabilityCausedAsk: boolean
  timestamp: string
}

export interface AuditReadinessStateV1 {
  schemaVersion: typeof AUDIT_READINESS_STATE_SCHEMA_VERSION
  cohort: {
    runtimeArtifactHash: string
    decisionConfigFingerprint: string
    boundaryFingerprint: string
  }
  availabilityAskCount: number
  firstAvailabilityAt?: string
  lastAvailabilityAt?: string
  updatedAt: string
}

export type AuditReadinessStateSnapshot =
  | { status: 'missing' }
  | { status: 'invalid' }
  | { status: 'valid'; state: AuditReadinessStateV1 }

export interface RetainedAvailabilityEvidence {
  availabilityAskCount: number
  firstAvailabilityAt?: string
  lastAvailabilityAt?: string
}

export function auditBoundaryFingerprint(boundaryProfile: string): string {
  return createHash('sha256').update(boundaryProfile).digest('hex')
}

export function isValidAuditReadinessTimestamp(timestamp: unknown): timestamp is string {
  return typeof timestamp === 'string' && ISO8601_PATTERN.test(timestamp)
}

export function isValidDecisionCohortIdentity(
  cohort: Partial<Record<keyof DecisionCohortIdentity, unknown>>,
): cohort is DecisionCohortIdentity {
  return (
    typeof cohort.runtimeArtifactHash === 'string' &&
    HEX64_PATTERN.test(cohort.runtimeArtifactHash) &&
    typeof cohort.decisionConfigFingerprint === 'string' &&
    HEX64_PATTERN.test(cohort.decisionConfigFingerprint) &&
    typeof cohort.boundaryProfile === 'string' &&
    cohort.boundaryProfile.length > 0 &&
    Buffer.byteLength(cohort.boundaryProfile, 'utf8') <= 1_024
  )
}

export function validAuditReadinessUpdate(update: AuditReadinessUpdate): boolean {
  return (
    isValidDecisionCohortIdentity(update.cohort) &&
    typeof update.availabilityCausedAsk === 'boolean' &&
    isValidAuditReadinessTimestamp(update.timestamp)
  )
}

export function parseAuditReadinessState(value: unknown): AuditReadinessStateV1 | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null
  }
  const candidate = value as Record<string, unknown>
  const cohort = candidate.cohort
  if (!cohort || typeof cohort !== 'object' || Array.isArray(cohort)) {
    return null
  }
  const cohortRecord = cohort as Record<string, unknown>
  const runtimeArtifactHash = cohortRecord.runtimeArtifactHash
  const decisionConfigFingerprint = cohortRecord.decisionConfigFingerprint
  const boundaryFingerprint = cohortRecord.boundaryFingerprint
  const availabilityAskCount = candidate.availabilityAskCount
  const updatedAt = candidate.updatedAt
  const firstAvailabilityAt = candidate.firstAvailabilityAt
  const lastAvailabilityAt = candidate.lastAvailabilityAt
  if (
    candidate.schemaVersion !== AUDIT_READINESS_STATE_SCHEMA_VERSION ||
    typeof runtimeArtifactHash !== 'string' ||
    !HEX64_PATTERN.test(runtimeArtifactHash) ||
    typeof decisionConfigFingerprint !== 'string' ||
    !HEX64_PATTERN.test(decisionConfigFingerprint) ||
    typeof boundaryFingerprint !== 'string' ||
    !HEX64_PATTERN.test(boundaryFingerprint) ||
    !Number.isSafeInteger(availabilityAskCount) ||
    (availabilityAskCount as number) < 0 ||
    !isValidAuditReadinessTimestamp(updatedAt) ||
    (firstAvailabilityAt !== undefined && !isValidAuditReadinessTimestamp(firstAvailabilityAt)) ||
    (lastAvailabilityAt !== undefined && !isValidAuditReadinessTimestamp(lastAvailabilityAt))
  ) {
    return null
  }
  if (
    ((availabilityAskCount as number) === 0 &&
      (firstAvailabilityAt !== undefined || lastAvailabilityAt !== undefined)) ||
    ((availabilityAskCount as number) > 0 &&
      (firstAvailabilityAt === undefined || lastAvailabilityAt === undefined))
  ) {
    return null
  }
  return {
    schemaVersion: AUDIT_READINESS_STATE_SCHEMA_VERSION,
    cohort: {
      runtimeArtifactHash,
      decisionConfigFingerprint,
      boundaryFingerprint,
    },
    availabilityAskCount: availabilityAskCount as number,
    ...(typeof firstAvailabilityAt === 'string' ? { firstAvailabilityAt } : {}),
    ...(typeof lastAvailabilityAt === 'string' ? { lastAvailabilityAt } : {}),
    updatedAt,
  }
}

export function readinessStateMatchesCohort(
  state: AuditReadinessStateV1,
  cohort: DecisionCohortIdentity,
): boolean {
  return (
    state.cohort.runtimeArtifactHash === cohort.runtimeArtifactHash &&
    state.cohort.decisionConfigFingerprint === cohort.decisionConfigFingerprint &&
    state.cohort.boundaryFingerprint === auditBoundaryFingerprint(cohort.boundaryProfile)
  )
}

export function auditRecordMatchesCohort(
  record: AuditRecord,
  cohort: DecisionCohortIdentity,
): boolean {
  return (
    record.runtimeArtifactHash === cohort.runtimeArtifactHash &&
    record.decisionConfigFingerprint === cohort.decisionConfigFingerprint &&
    record.boundaryProfile === cohort.boundaryProfile
  )
}

export function buildAuditReadinessState(
  update: AuditReadinessUpdate,
  retainedEvidence?: RetainedAvailabilityEvidence,
): AuditReadinessStateV1 {
  const previousCount = retainedEvidence?.availabilityAskCount ?? 0
  const availabilityAskCount = update.availabilityCausedAsk
    ? Math.min(Number.MAX_SAFE_INTEGER, previousCount + 1)
    : previousCount
  return {
    schemaVersion: AUDIT_READINESS_STATE_SCHEMA_VERSION,
    cohort: {
      runtimeArtifactHash: update.cohort.runtimeArtifactHash,
      decisionConfigFingerprint: update.cohort.decisionConfigFingerprint,
      boundaryFingerprint: auditBoundaryFingerprint(update.cohort.boundaryProfile),
    },
    availabilityAskCount,
    ...(availabilityAskCount > 0
      ? {
          firstAvailabilityAt: retainedEvidence?.firstAvailabilityAt ?? update.timestamp,
          lastAvailabilityAt: update.availabilityCausedAsk
            ? update.timestamp
            : retainedEvidence?.lastAvailabilityAt,
        }
      : {}),
    updatedAt: update.timestamp,
  }
}
