import { constants } from 'node:fs'
import { type FileHandle, lstat, mkdir, open, rename, unlink } from 'node:fs/promises'
import path from 'node:path'
import { performance } from 'node:perf_hooks'

const AUDIT_LOCK_TIMEOUT_MS = 2_000
const AUDIT_LOCK_RETRY_DELAY_MS = 25

export interface AppendBoundedAuditLineOptions {
  auditPath: string
  line: string
  maxBytes: number
  maxFiles: number
}

interface FileIdentity {
  dev: bigint
  ino: bigint
}

interface AcquiredAuditLock {
  handle: FileHandle
  identity: FileIdentity
  lockPath: string
}

function errno(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException).code
}

async function lstatIfPresent(filePath: string) {
  try {
    return await lstat(filePath)
  } catch (error) {
    if (errno(error) === 'ENOENT') return null
    throw error
  }
}

async function assertNotSymlink(filePath: string, label: string): Promise<void> {
  const info = await lstatIfPresent(filePath)
  if (info?.isSymbolicLink()) {
    throw new Error(`Refusing symbolic link for ${label}: ${filePath}`)
  }
}

function noFollowFlag(): number {
  return typeof constants.O_NOFOLLOW === 'number' ? constants.O_NOFOLLOW : 0
}

function fileIdentity(stats: { dev: number | bigint; ino: number | bigint }): FileIdentity {
  return { dev: BigInt(stats.dev), ino: BigInt(stats.ino) }
}

function sameIdentity(
  left: FileIdentity,
  right: { dev: number | bigint; ino: number | bigint },
): boolean {
  return left.dev === BigInt(right.dev) && left.ino === BigInt(right.ino)
}

async function acquireAuditLock(lockPath: string): Promise<AcquiredAuditLock> {
  const deadline = performance.now() + AUDIT_LOCK_TIMEOUT_MS
  const flags = constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | noFollowFlag()

  for (;;) {
    try {
      const handle = await open(lockPath, flags, 0o600)
      return {
        handle,
        identity: fileIdentity(await handle.stat({ bigint: true })),
        lockPath,
      }
    } catch (error) {
      const code = errno(error)
      if (code !== 'EEXIST' && code !== 'ELOOP') throw error
      await assertNotSymlink(lockPath, 'audit lock')
      const remainingMs = deadline - performance.now()
      if (remainingMs <= 0) {
        throw new Error(
          `Audit lock acquisition timed out after ${AUDIT_LOCK_TIMEOUT_MS}ms: ${lockPath}`,
        )
      }
      await new Promise<void>((resolve) => {
        setTimeout(resolve, Math.min(AUDIT_LOCK_RETRY_DELAY_MS, remainingMs))
      })
    }
  }
}

async function releaseAuditLock(lock: AcquiredAuditLock): Promise<void> {
  await lock.handle.close().catch(() => undefined)
  try {
    const current = await lstat(lock.lockPath, { bigint: true })
    if (sameIdentity(lock.identity, current)) {
      await unlink(lock.lockPath)
    }
  } catch (error) {
    if (errno(error) !== 'ENOENT') throw error
  }
}

export function auditGenerationPath(auditPath: string, generation: number): string {
  if (!Number.isInteger(generation) || generation < 1) {
    throw new Error(`Audit generation must be a positive integer: ${generation}`)
  }
  return `${path.resolve(auditPath)}.${generation}`
}

async function renameIfPresent(sourcePath: string, destinationPath: string): Promise<void> {
  if (await lstatIfPresent(sourcePath)) {
    await rename(sourcePath, destinationPath)
  }
}

async function unlinkIfPresent(filePath: string): Promise<void> {
  try {
    await unlink(filePath)
  } catch (error) {
    if (errno(error) !== 'ENOENT') throw error
  }
}

async function rotateAuditFiles(auditPath: string, maxFiles: number): Promise<void> {
  if (maxFiles === 1) {
    await unlinkIfPresent(auditPath)
    return
  }

  const oldestGeneration = maxFiles - 1
  await unlinkIfPresent(auditGenerationPath(auditPath, oldestGeneration))
  for (let generation = oldestGeneration - 1; generation >= 1; generation -= 1) {
    await renameIfPresent(
      auditGenerationPath(auditPath, generation),
      auditGenerationPath(auditPath, generation + 1),
    )
  }
  await renameIfPresent(auditPath, auditGenerationPath(auditPath, 1))
}

async function activeAuditSize(auditPath: string): Promise<{ exists: boolean; size: number }> {
  const info = await lstatIfPresent(auditPath)
  if (!info) return { exists: false, size: 0 }
  if (info.isSymbolicLink()) {
    throw new Error(`Refusing symbolic link for active audit log: ${auditPath}`)
  }
  if (!info.isFile()) {
    throw new Error(`Active audit path is not a regular file: ${auditPath}`)
  }
  return { exists: true, size: info.size }
}

async function appendCompleteLine(auditPath: string, bytes: Buffer): Promise<void> {
  const flags = constants.O_CREAT | constants.O_WRONLY | constants.O_APPEND | noFollowFlag()
  const handle = await open(auditPath, flags, 0o600)
  let initialSize: number | undefined
  try {
    const info = await handle.stat({ bigint: true })
    if (!info.isFile()) {
      throw new Error(`Active audit path is not a regular file: ${auditPath}`)
    }
    const current = await lstat(auditPath, { bigint: true })
    if (current.isSymbolicLink() || !sameIdentity(fileIdentity(info), current)) {
      throw new Error(`Refusing replaced or symbolic link for active audit log: ${auditPath}`)
    }
    initialSize = Number(info.size)
    const { bytesWritten } = await handle.write(bytes, 0, bytes.length, null)
    if (bytesWritten !== bytes.length) {
      throw new Error(
        `Incomplete audit line append: wrote ${bytesWritten} of ${bytes.length} bytes`,
      )
    }
  } catch (error) {
    if (initialSize !== undefined) {
      await handle.truncate(initialSize).catch(() => undefined)
    }
    throw error
  } finally {
    await handle.close()
  }
}

/**
 * Append one already serialized NDJSON record under a sibling lock.
 *
 * A single record may exceed maxBytes. It remains whole and becomes the active file after any
 * applicable rotation; maxBytes is a rotation threshold, not a record truncation limit.
 */
export async function appendBoundedAuditLine(
  options: AppendBoundedAuditLineOptions,
): Promise<void> {
  if (!Number.isInteger(options.maxBytes) || options.maxBytes < 1) {
    throw new Error(`Audit maxBytes must be a positive integer: ${options.maxBytes}`)
  }
  if (!Number.isInteger(options.maxFiles) || options.maxFiles < 1) {
    throw new Error(`Audit maxFiles must be a positive integer: ${options.maxFiles}`)
  }

  const auditPath = path.resolve(options.auditPath)
  const lockPath = `${auditPath}.lock`
  const record = options.line.replace(/[\r\n]+$/u, '')
  const bytes = Buffer.from(`${record}\n`, 'utf8')
  await mkdir(path.dirname(auditPath), { recursive: true })
  await assertNotSymlink(lockPath, 'audit lock')

  const lock = await acquireAuditLock(lockPath)
  try {
    const active = await activeAuditSize(auditPath)
    if (active.exists && active.size + bytes.length > options.maxBytes) {
      await assertNotSymlink(auditPath, 'active audit log')
      await rotateAuditFiles(auditPath, options.maxFiles)
    }
    await appendCompleteLine(auditPath, bytes)
  } finally {
    await releaseAuditLock(lock)
  }
}
