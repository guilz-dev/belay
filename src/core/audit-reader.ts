import { createReadStream, existsSync } from 'node:fs'
import { type FileHandle, open, stat } from 'node:fs/promises'
import path from 'node:path'
import { createInterface } from 'node:readline'

import { parseAuditNdjsonLine } from './audit-serialize.js'
import { rotatedAuditPath, withAuditLock } from './audit-sink.js'
import type { AuditRetentionConfig } from './config.js'

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

export function resolveAuditLogFiles(
  auditPath: string,
  retention?: AuditRetentionConfig,
): string[] {
  if (isLegacyArchivePath(auditPath)) {
    return existsSync(auditPath) ? [auditPath] : []
  }

  const files: string[] = []
  const maxFiles = retention?.maxFiles ?? 0
  if (maxFiles > 1) {
    for (let generation = maxFiles - 1; generation >= 1; generation -= 1) {
      const rotated = rotatedAuditPath(auditPath, generation)
      if (existsSync(rotated) && !isLegacyArchivePath(rotated)) {
        files.push(rotated)
      }
    }
  }
  if (existsSync(auditPath)) {
    files.push(auditPath)
  }
  return files
}

export async function readAuditNdjsonFiles(
  auditPaths: string[],
): Promise<{ records: Record<string, unknown>[]; malformedLines: number }> {
  const records: Record<string, unknown>[] = []
  let malformedLines = 0

  for (const auditPath of auditPaths) {
    if (!existsSync(auditPath)) {
      continue
    }
    try {
      await new Promise<void>((resolve, reject) => {
        const input = createReadStream(auditPath, { encoding: 'utf8' })
        input.on('error', (error: NodeJS.ErrnoException) => {
          if (error.code === 'ENOENT') {
            resolve()
            return
          }
          reject(error)
        })
        const lines = createInterface({ input, crlfDelay: Number.POSITIVE_INFINITY })
        void (async () => {
          try {
            for await (const line of lines) {
              const parsed = parseAuditNdjsonLine(line)
              if (!parsed) {
                if (line.trim()) {
                  malformedLines += 1
                }
                continue
              }
              records.push(parsed)
            }
            resolve()
          } catch (error) {
            reject(error)
          }
        })()
      })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        continue
      }
      throw error
    }
  }

  return { records, malformedLines }
}

export async function readAuditRecordsFromPath(
  auditPath: string,
  retention?: AuditRetentionConfig,
): Promise<{ records: Record<string, unknown>[]; malformedLines: number }> {
  const snapshots = await withAuditLock(auditPath, async () => {
    const opened: Array<{ handle: FileHandle; size: number }> = []
    try {
      for (const filePath of resolveAuditLogFiles(auditPath, retention)) {
        try {
          const handle = await open(filePath, 'r')
          const fileStat = await handle.stat()
          opened.push({ handle, size: fileStat.size })
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
            throw error
          }
        }
      }
      return opened
    } catch (error) {
      await Promise.all(opened.map(({ handle }) => handle.close()))
      throw error
    }
  })

  const records: Record<string, unknown>[] = []
  let malformedLines = 0
  try {
    for (const { handle, size } of snapshots) {
      if (size === 0) {
        continue
      }
      const input = handle.createReadStream({
        encoding: 'utf8',
        start: 0,
        end: size - 1,
        autoClose: false,
      })
      const lines = createInterface({ input, crlfDelay: Number.POSITIVE_INFINITY })
      for await (const line of lines) {
        const parsed = parseAuditNdjsonLine(line)
        if (!parsed) {
          if (line.trim()) {
            malformedLines += 1
          }
          continue
        }
        records.push(parsed)
      }
    }
  } finally {
    await Promise.all(snapshots.map(({ handle }) => handle.close()))
  }
  return { records, malformedLines }
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
      if (filePath === auditPath) {
        activeBytes = fileStat.size
      }
    } catch {
      // skip missing
    }
  }

  const { malformedLines } = await readAuditRecordsFromPath(auditPath, retention)

  return {
    activeBytes,
    totalBytes,
    files: files.length,
    malformedLines,
    maxBytes: retention?.maxBytes ?? 0,
    maxFiles: retention?.maxFiles ?? 0,
    retentionEnabled: Boolean(retention && retention.maxBytes > 0 && retention.maxFiles > 0),
  }
}

export function resolveRepoAuditPath(repoRoot: string, logPath: string): string {
  return path.isAbsolute(logPath) ? logPath : path.join(repoRoot, logPath)
}
