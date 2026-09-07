import { existsSync } from 'node:fs'
import { appendFile, mkdir, open, readdir, rename, stat, unlink } from 'node:fs/promises'
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

export async function withAuditLock<T>(auditPath: string, operation: () => Promise<T>): Promise<T> {
  const release = await acquireAuditLock(auditPath)
  try {
    return await operation()
  } finally {
    await release()
  }
}

export function isRetentionEnabled(retention?: AuditRetentionConfig): boolean {
  return retention !== undefined && retention.maxBytes > 0 && retention.maxFiles > 0
}

export function rotatedAuditPath(auditPath: string, generation: number): string {
  return `${auditPath}.${generation}`
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

async function removeExcessGenerations(auditPath: string, maxArchived: number): Promise<void> {
  const directory = path.dirname(auditPath)
  const baseName = path.basename(auditPath)
  const generationPattern = new RegExp(`^${escapeRegex(baseName)}\\.(\\d+)$`)
  let entries: string[]
  try {
    entries = await readdir(directory)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return
    }
    throw error
  }
  await Promise.all(
    entries.map(async (entry) => {
      const match = entry.match(generationPattern)
      const generation = match?.[1] ? Number.parseInt(match[1], 10) : 0
      if (generation > maxArchived) {
        await unlink(path.join(directory, entry))
      }
    }),
  )
}

export async function maybeRotateAuditLog(
  auditPath: string,
  retention: AuditRetentionConfig,
): Promise<boolean> {
  if (!isRetentionEnabled(retention)) {
    return false
  }
  const maxArchived = Math.max(0, retention.maxFiles - 1)
  await removeExcessGenerations(auditPath, maxArchived)
  if (!existsSync(auditPath)) {
    return false
  }
  const fileStat = await stat(auditPath)
  if (fileStat.size < retention.maxBytes) {
    return false
  }

  if (maxArchived === 0) {
    await unlink(auditPath)
    await appendFile(auditPath, '', 'utf8')
    return true
  }
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

  await withAuditLock(auditPath, async () => {
    if (retention && isRetentionEnabled(retention)) {
      await maybeRotateAuditLog(auditPath, retention)
    }
    await appendAuditRecord(auditPath, record, scrubOptions)
  })
}
