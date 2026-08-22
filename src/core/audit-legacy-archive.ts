import { existsSync } from 'node:fs'
import { readFile, rename } from 'node:fs/promises'
import path from 'node:path'

import type { BelayConfigV3 } from './config.js'

const LEGACY_PLACEHOLDER_MARKERS = ['"<timestamp>"', '"<high-entropy>"', '"<approval-id>"'] as const

export function auditLogHasLegacyScrubPlaceholders(sample: string): boolean {
  return LEGACY_PLACEHOLDER_MARKERS.some((marker) => sample.includes(marker))
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

  const sample = await readFile(auditPath, 'utf8')
  const head = sample.slice(0, 256_000)
  if (!auditLogHasLegacyScrubPlaceholders(head)) {
    return { archived: false }
  }

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
  const archivePath = `${auditPath}.legacy-${timestamp}.ndjson`
  await rename(auditPath, archivePath)
  return { archived: true, archivedPath: archivePath }
}
