import { existsSync, readdirSync } from 'node:fs'
import { stat } from 'node:fs/promises'
import path from 'node:path'

import {
  loadRetainedAuditRecords,
  MAX_AUDIT_RECORD_BYTES,
} from './audit-storage.js'
import { rotatedAuditPath } from './audit-sink.js'
import {
  MAX_AUDIT_FILES,
  type AuditRetentionConfig,
  normalizeAuditRetention,
} from './config.js'

export interface AuditStorageStats {
  activeBytes: number
  totalBytes: number
  files: number
  malformedLines: number
  maxBytes: number
  maxFiles: number
  retentionEnabled: boolean
}

function isLegacyArchivePath(filePath: string): boolean {
  return /\.legacy-[^/\\]+\.ndjson$/i.test(filePath)
}

function auditGenerations(auditPath: string): number[] {
  const directory = path.dirname(auditPath)
  const escapedName = path.basename(auditPath).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const generationPattern = new RegExp(`^${escapedName}\\.(\\d+)$`)
  try {
    return readdirSync(directory)
      .map((entry) => {
        const match = entry.match(generationPattern)
        return match ? Number(match[1]) : Number.NaN
      })
      .filter((generation) => Number.isSafeInteger(generation) && generation > 0)
      .sort((left, right) => right - left)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
}

export function resolveAuditLogFiles(
  auditPath: string,
  retention?: AuditRetentionConfig,
): string[] {
  if (isLegacyArchivePath(auditPath)) {
    return existsSync(auditPath) ? [auditPath] : []
  }
  const retentionEnabled = Boolean(retention && retention.maxBytes > 0 && retention.maxFiles > 0)
  const generations = auditGenerations(auditPath)
    .filter((generation) => !retentionEnabled || generation < (retention?.maxFiles ?? 1))
    .map((generation) => rotatedAuditPath(auditPath, generation))
  if (existsSync(auditPath)) generations.push(auditPath)
  return generations
}

function canonicalReadMaxFiles(auditPath: string, retention?: AuditRetentionConfig): number {
  if (retention && retention.maxBytes > 0 && retention.maxFiles > 0) {
    return normalizeAuditRetention(retention).maxFiles
  }
  const oldestGeneration = auditGenerations(auditPath)[0] ?? 0
  return Math.max(1, Math.min(MAX_AUDIT_FILES, oldestGeneration + 1))
}

/** Compatibility adapter. Record parsing and snapshots stay owned by audit-storage. */
export async function readAuditRecordsFromPath(
  auditPath: string,
  retention?: AuditRetentionConfig,
): Promise<{ records: Record<string, unknown>[]; malformedLines: number }> {
  const loaded = await loadRetainedAuditRecords({
    auditPath,
    maxFiles: canonicalReadMaxFiles(auditPath, retention),
    maxLineBytes: MAX_AUDIT_RECORD_BYTES,
  })
  return { records: loaded.records, malformedLines: loaded.diagnostics.malformedLines }
}

export async function statAuditStorage(
  auditPath: string,
  retention?: AuditRetentionConfig,
): Promise<AuditStorageStats> {
  const files = resolveAuditLogFiles(auditPath, retention)
  let activeBytes = 0
  let totalBytes = 0
  for (const filePath of files) {
    try {
      const fileStat = await stat(filePath)
      totalBytes += fileStat.size
      if (filePath === auditPath) activeBytes = fileStat.size
    } catch {
      // A canonical read snapshot tolerates generations disappearing before its lock is acquired.
    }
  }
  const { malformedLines } = await readAuditRecordsFromPath(auditPath, retention)
  const normalized = normalizeAuditRetention(retention)
  return {
    activeBytes,
    totalBytes,
    files: files.length,
    malformedLines,
    maxBytes: retention?.maxBytes ?? normalized.maxBytes,
    maxFiles: retention?.maxFiles ?? normalized.maxFiles,
    retentionEnabled: Boolean(retention && retention.maxBytes > 0 && retention.maxFiles > 0),
  }
}

export function resolveRepoAuditPath(repoRoot: string, logPath: string): string {
  return path.isAbsolute(logPath) ? logPath : path.join(repoRoot, logPath)
}
