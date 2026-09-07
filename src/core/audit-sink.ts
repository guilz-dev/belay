import { existsSync } from 'node:fs'
import { appendFile, mkdir, open, readdir, rename, stat, unlink } from 'node:fs/promises'
import path from 'node:path'

import { serializeAuditRecordV3 } from './audit-serialize.js'
import type { AuditRetentionConfig } from './config.js'
import type { ScrubOptions } from './types.js'

const LOCK_RETRIES = 500
const LOCK_RETRY_MS = 5

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
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
        throw error
      }
      if (attempt < LOCK_RETRIES - 1) {
        await sleep(LOCK_RETRY_MS)
      }
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

async function auditGenerations(auditPath: string): Promise<number[]> {
  let entries: string[] = []
  try {
    entries = await readdir(path.dirname(auditPath))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  const escapedName = path.basename(auditPath).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const generationPattern = new RegExp(`^${escapedName}\\.(\\d+)$`)
  return entries
    .map((entry) => {
      const match = entry.match(generationPattern)
      return match ? Number(match[1]) : Number.NaN
    })
    .filter((generation) => Number.isSafeInteger(generation) && generation > 0)
    .sort((left, right) => right - left)
}

async function pruneExcessGenerations(auditPath: string, maxFiles: number): Promise<void> {
  if (maxFiles <= 0) return
  await Promise.all(
    (await auditGenerations(auditPath))
      .filter((generation) => generation >= maxFiles)
      .map(async (generation) => {
        try {
          await unlink(rotatedAuditPath(auditPath, generation))
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        }
      }),
  )
}

export async function maybeRotateAuditLog(
  auditPath: string,
  retention: AuditRetentionConfig,
  incomingBytes = 0,
): Promise<boolean> {
  if (!isRetentionEnabled(retention)) {
    return false
  }
  await pruneExcessGenerations(auditPath, retention.maxFiles)
  if (!existsSync(auditPath)) return false
  const fileStat = await stat(auditPath)
  if (fileStat.size === 0 || fileStat.size + incomingBytes <= retention.maxBytes) {
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

  if (maxArchived === 0) {
    await unlink(auditPath)
  } else if (existsSync(auditPath)) {
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
    const line = `${JSON.stringify(serializeAuditRecordV3(record, scrubOptions))}\n`
    if (retention && isRetentionEnabled(retention)) {
      await maybeRotateAuditLog(auditPath, retention, Buffer.byteLength(line, 'utf8'))
    }
    await appendFile(auditPath, line, 'utf8')
  } finally {
    await release()
  }
}
