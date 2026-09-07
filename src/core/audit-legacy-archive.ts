import { createReadStream } from 'node:fs'
import { lstat, rename } from 'node:fs/promises'
import path from 'node:path'
import { createInterface } from 'node:readline'

import { withAuditStorageLock } from './audit-storage.js'
import type { BelayConfigV3 } from './config.js'

const LEGACY_PLACEHOLDER_PATTERNS = [
  /"(?:timestamp|ts)"\s*:\s*"<timestamp>"/,
  /"(?:fingerprint|commandFingerprint|effectIRHash|payloadHash|configFingerprint|runtimeArtifactHash|decisionConfigFingerprint|receiptHash)"\s*:\s*"<high-entropy>"/,
  /"approvalId"\s*:\s*"<approval-id>"/,
] as const

const LEGACY_HIGH_ENTROPY_FIELDS = [
  'fingerprint',
  'commandFingerprint',
  'effectIRHash',
  'payloadHash',
  'configFingerprint',
  'runtimeArtifactHash',
  'decisionConfigFingerprint',
  'receiptHash',
] as const

export function auditLogHasLegacyScrubPlaceholders(sample: string): boolean {
  for (const line of sample.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed) {
      continue
    }
    try {
      const parsed = JSON.parse(trimmed) as unknown
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
        if (auditRecordHasLegacyCorrelationPlaceholders(parsed as Record<string, unknown>)) {
          return true
        }
        continue
      }
    } catch {
      // Malformed legacy lines still need archival before a new runtime appends to the log.
    }
    if (LEGACY_PLACEHOLDER_PATTERNS.some((pattern) => pattern.test(trimmed))) {
      return true
    }
  }
  return false
}

export function auditRecordHasLegacyCorrelationPlaceholders(
  record: Record<string, unknown>,
): boolean {
  return (
    record.timestamp === '<timestamp>' ||
    record.ts === '<timestamp>' ||
    LEGACY_HIGH_ENTROPY_FIELDS.some((field) => record[field] === '<high-entropy>') ||
    record.approvalId === '<approval-id>'
  )
}

async function auditFileHasLegacyScrubPlaceholders(auditPath: string): Promise<boolean> {
  const input = createReadStream(auditPath, { encoding: 'utf8' })
  const lines = createInterface({ input, crlfDelay: Number.POSITIVE_INFINITY })
  for await (const line of lines) {
    if (auditLogHasLegacyScrubPlaceholders(line)) {
      return true
    }
  }
  return false
}

function errno(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException).code
}

async function auditFileIdentityIfPresent(
  auditPath: string,
): Promise<{ dev: bigint; ino: bigint } | null> {
  try {
    const info = await lstat(auditPath, { bigint: true })
    if (info.isSymbolicLink()) {
      throw new Error(`Refusing symbolic link for active audit log: ${auditPath}`)
    }
    if (!info.isFile()) {
      throw new Error(`Active audit path is not a regular file: ${auditPath}`)
    }
    return { dev: info.dev, ino: info.ino }
  } catch (error) {
    if (errno(error) === 'ENOENT') return null
    throw error
  }
}

export async function archiveLegacyAuditLogIfNeeded(
  repoRoot: string,
  config: BelayConfigV3,
): Promise<{ archived: boolean; archivedPath?: string }> {
  const auditPath = path.isAbsolute(config.audit.logPath)
    ? config.audit.logPath
    : path.join(repoRoot, config.audit.logPath)
  return withAuditStorageLock(auditPath, async (lockedAuditPath) => {
    const identity = await auditFileIdentityIfPresent(lockedAuditPath)
    if (!identity) {
      return { archived: false }
    }

    if (!(await auditFileHasLegacyScrubPlaceholders(lockedAuditPath))) {
      return { archived: false }
    }

    const currentIdentity = await auditFileIdentityIfPresent(lockedAuditPath)
    if (
      !currentIdentity ||
      currentIdentity.dev !== identity.dev ||
      currentIdentity.ino !== identity.ino
    ) {
      throw new Error(`Audit log changed during legacy scan: ${lockedAuditPath}`)
    }

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
    const archivePath = `${lockedAuditPath}.legacy-${timestamp}.ndjson`
    await rename(lockedAuditPath, archivePath)
    return { archived: true, archivedPath: archivePath }
  })
}
