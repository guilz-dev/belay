import { appendAuditRecord } from './audit-serialize.js'
import { maybeRotateBoundedAuditLog } from './audit-storage.js'
import {
  type AuditRetentionConfig,
  DEFAULT_AUDIT_RETENTION,
  normalizeAuditRetention,
} from './config.js'
import type { ScrubOptions } from './types.js'

export interface AuditSinkAppendOptions {
  auditPath: string
  record: Record<string, unknown>
  scrubOptions: ScrubOptions
  retention?: AuditRetentionConfig
}

export function isRetentionEnabled(retention?: AuditRetentionConfig): boolean {
  return retention !== undefined && retention.maxBytes > 0 && retention.maxFiles > 0
}

export function rotatedAuditPath(auditPath: string, generation: number): string {
  return `${auditPath}.${generation}`
}

/** Compatibility adapter. The canonical storage module owns locking and rotation. */
export async function maybeRotateAuditLog(
  auditPath: string,
  retention: AuditRetentionConfig,
  incomingBytes = 0,
): Promise<boolean> {
  if (!isRetentionEnabled(retention)) {
    return false
  }
  const bounds = normalizeAuditRetention(retention)
  return maybeRotateBoundedAuditLog({ auditPath, ...bounds, incomingBytes })
}

/** Compatibility adapter. Serialization and append both delegate to the canonical path. */
export async function appendAuditLine(options: AuditSinkAppendOptions): Promise<void> {
  const bounds = options.retention
    ? normalizeAuditRetention(options.retention)
    : DEFAULT_AUDIT_RETENTION
  await appendAuditRecord(options.auditPath, options.record, options.scrubOptions, {
    ...bounds,
    ...(options.retention ? { retention: bounds } : {}),
  })
}
