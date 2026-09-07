import { existsSync } from 'node:fs'
import { appendFile, mkdir, open, rename, stat, unlink } from 'node:fs/promises'
import path from 'node:path'

import { appendAuditRecord } from './audit-serialize.js'
import type { AuditRetentionConfig } from './config.js'
import type { ScrubOptions } from './types.js'

const LOCK_RETRIES = 5
const LOCK_RETRY_MS = 20
const LOCK_STALE_MS = 60_000

export interface AuditSinkAppendOptions {
  auditPath: string
  record: Record<string, unknown>
  scrubOptions: ScrubOptions
  retention?: AuditRetentionConfig
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms))
}

function lockPath(auditPath: string): string {
  return `${auditPath}.lock`
}

async function removeStaleLock(lockFile: string): Promise<boolean> {
  try {
    const lockStat = await stat(lockFile)
    if (Date.now() - lockStat.mtimeMs <= LOCK_STALE_MS) {
      return false
    }
    await unlink(lockFile)
    return true
  } catch {
    return false
  }
}

async function acquireAuditLock(auditPath: string): Promise<() => Promise<void>> {
  const lockFile = lockPath(auditPath)
  await mkdir(path.dirname(lockFile), { recursive: true })
  let lastError: unknown
  for (let attempt = 0; attempt < LOCK_RETRIES; attempt += 1) {
    try {
      const handle = await open(lockFile, 'wx')
      await handle.close()
      return async () => {
        try {
          await unlink(lockFile)
        } catch {
          // best effort
        }
      }
    } catch (error) {
      lastError = error
      if (attempt < LOCK_RETRIES - 1) {
        await sleep(LOCK_RETRY_MS)
      }
    }
  }
  if (await removeStaleLock(lockFile)) {
    try {
      const handle = await open(lockFile, 'wx')
      await handle.close()
      return async () => {
        try {
          await unlink(lockFile)
        } catch {
          // best effort
        }
      }
    } catch (error) {
      lastError = error
    }
  }
  throw lastError instanceof Error ? lastError : new Error('Failed to acquire audit lock')
}

export function isRetentionEnabled(retention?: AuditRetentionConfig): boolean {
  return retention !== undefined && retention.maxBytes > 0 && retention.maxFiles > 0
}

export function rotatedAuditPath(auditPath: string, generation: number): string {
  return `${auditPath}.${generation}`
}

export async function maybeRotateAuditLog(
  auditPath: string,
  retention: AuditRetentionConfig,
): Promise<boolean> {
  if (!isRetentionEnabled(retention)) {
    return false
  }
  if (!existsSync(auditPath)) {
    return false
  }
  const fileStat = await stat(auditPath)
  if (fileStat.size < retention.maxBytes) {
    return false
  }

  const maxArchived = Math.max(0, retention.maxFiles - 1)
  if (maxArchived > 0) {
    const oldest = rotatedAuditPath(auditPath, maxArchived)
    if (existsSync(oldest)) {
      await unlink(oldest)
    }
  }
  for (let generation = maxArchived - 1; generation >= 1; generation -= 1) {
    const current = rotatedAuditPath(auditPath, generation)
    const next = rotatedAuditPath(auditPath, generation + 1)
    if (existsSync(current)) {
      await rename(current, next)
    }
  }

  if (existsSync(auditPath)) {
    await rename(auditPath, rotatedAuditPath(auditPath, 1))
  }

  await appendFile(auditPath, '', 'utf8')
  return true
}

export async function appendAuditLine(options: AuditSinkAppendOptions): Promise<void> {
  const { auditPath, record, scrubOptions, retention } = options
  await mkdir(path.dirname(auditPath), { recursive: true })

  const release = await acquireAuditLock(auditPath)
  try {
    if (retention && isRetentionEnabled(retention)) {
      await maybeRotateAuditLog(auditPath, retention)
    }
    await appendAuditRecord(auditPath, record, scrubOptions)
  } finally {
    await release()
  }
}
