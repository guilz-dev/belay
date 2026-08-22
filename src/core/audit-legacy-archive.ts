import { existsSync } from 'node:fs'
import { open, rename } from 'node:fs/promises'
import path from 'node:path'

import type { BelayConfigV3 } from './config.js'

const LEGACY_PLACEHOLDER_PATTERNS = [
  /"(?:timestamp|ts)"\s*:\s*"<timestamp>"/,
  /"(?:fingerprint|commandFingerprint|effectIRHash|payloadHash|configFingerprint|runtimeArtifactHash|decisionConfigFingerprint|receiptHash)"\s*:\s*"<high-entropy>"/,
  /"approvalId"\s*:\s*"<approval-id>"/,
] as const

const AUDIT_SCAN_CHUNK_BYTES = 64 * 1024
const AUDIT_SCAN_OVERLAP_CHARS = 256

export function auditLogHasLegacyScrubPlaceholders(sample: string): boolean {
  return LEGACY_PLACEHOLDER_PATTERNS.some((pattern) => pattern.test(sample))
}

async function auditFileHasLegacyScrubPlaceholders(auditPath: string): Promise<boolean> {
  const handle = await open(auditPath, 'r')
  const buffer = Buffer.allocUnsafe(AUDIT_SCAN_CHUNK_BYTES)
  let carry = ''
  let position = 0
  try {
    while (true) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, position)
      if (bytesRead === 0) {
        return false
      }
      const sample = carry + buffer.toString('utf8', 0, bytesRead)
      if (auditLogHasLegacyScrubPlaceholders(sample)) {
        return true
      }
      carry = sample.slice(-AUDIT_SCAN_OVERLAP_CHARS)
      position += bytesRead
    }
  } finally {
    await handle.close()
  }
}

export async function archiveLegacyAuditLogIfNeeded(
  repoRoot: string,
  config: BelayConfigV3,
): Promise<{ archived: boolean; archivedPath?: string }> {
  const auditPath = path.isAbsolute(config.audit.logPath)
    ? config.audit.logPath
    : path.join(repoRoot, config.audit.logPath)
  if (!existsSync(auditPath)) {
    return { archived: false }
  }

  if (!(await auditFileHasLegacyScrubPlaceholders(auditPath))) {
    return { archived: false }
  }

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
  const archivePath = `${auditPath}.legacy-${timestamp}.ndjson`
  await rename(auditPath, archivePath)
  return { archived: true, archivedPath: archivePath }
}
