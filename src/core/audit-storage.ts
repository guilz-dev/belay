import { randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { type FileHandle, lstat, mkdir, open, rename, unlink } from 'node:fs/promises'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import { MAX_AUDIT_FILES } from './config.js'

const AUDIT_LOCK_TIMEOUT_MS = 2_000
const AUDIT_LOCK_RETRY_DELAY_MS = 25

export interface AppendBoundedAuditLineOptions {
  auditPath: string
  line: string
  maxBytes: number
  maxFiles: number
}

export interface AuditStorageOperations {
  open(filePath: string, flags: number, mode: number): Promise<FileHandle>
  rename(sourcePath: string, destinationPath: string): Promise<void>
  write(handle: FileHandle, bytes: Buffer): Promise<number>
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

interface OwnedAuditPath {
  identity: FileIdentity
  path: string
}

interface CompletedMove extends OwnedAuditPath {
  sourcePath: string
}

const DEFAULT_AUDIT_STORAGE_OPERATIONS: AuditStorageOperations = {
  open,
  rename,
  async write(handle, bytes) {
    const { bytesWritten } = await handle.write(bytes, 0, bytes.length, null)
    return bytesWritten
  },
}

function resolveOperations(overrides: Partial<AuditStorageOperations>): AuditStorageOperations {
  return { ...DEFAULT_AUDIT_STORAGE_OPERATIONS, ...overrides }
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

async function lstatBigintIfPresent(filePath: string) {
  try {
    return await lstat(filePath, { bigint: true })
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

async function acquireAuditLock(
  lockPath: string,
  operations: AuditStorageOperations,
): Promise<AcquiredAuditLock> {
  const deadline = performance.now() + AUDIT_LOCK_TIMEOUT_MS
  const flags = constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | noFollowFlag()

  for (;;) {
    try {
      const handle = await operations.open(lockPath, flags, 0o600)
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

export async function withAuditStorageLock<T>(
  auditPathInput: string,
  operation: (resolvedAuditPath: string) => Promise<T>,
  operationOverrides: Partial<AuditStorageOperations> = {},
): Promise<T> {
  const auditPath = path.resolve(auditPathInput)
  const lockPath = `${auditPath}.lock`
  const operations = resolveOperations(operationOverrides)
  await mkdir(path.dirname(auditPath), { recursive: true })
  await assertNotSymlink(lockPath, 'audit lock')

  const lock = await acquireAuditLock(lockPath, operations)
  try {
    return await operation(auditPath)
  } finally {
    await releaseAuditLock(lock)
  }
}

export function auditGenerationPath(auditPath: string, generation: number): string {
  if (!Number.isInteger(generation) || generation < 1) {
    throw new Error(`Audit generation must be a positive integer: ${generation}`)
  }
  return `${path.resolve(auditPath)}.${generation}`
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

async function appendCompleteLine(
  auditPath: string,
  bytes: Buffer,
  operations: AuditStorageOperations,
): Promise<void> {
  const flags = constants.O_CREAT | constants.O_WRONLY | constants.O_APPEND | noFollowFlag()
  const handle = await operations.open(auditPath, flags, 0o600)
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
    const bytesWritten = await operations.write(handle, bytes)
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

async function unlinkOwnedPath(owned: OwnedAuditPath): Promise<void> {
  const current = await lstatBigintIfPresent(owned.path)
  if (!current) return
  if (!sameIdentity(owned.identity, current)) {
    throw new Error(`Refusing to remove replaced audit transaction path: ${owned.path}`)
  }
  await unlink(owned.path)
}

async function createStagedAuditLine(
  auditPath: string,
  bytes: Buffer,
  transactionId: string,
  operations: AuditStorageOperations,
): Promise<OwnedAuditPath> {
  const stagingPath = `${auditPath}.transaction-${transactionId}.staging`
  const flags = constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | noFollowFlag()
  const handle = await operations.open(stagingPath, flags, 0o600)
  let owned: OwnedAuditPath | undefined
  try {
    const info = await handle.stat({ bigint: true })
    if (!info.isFile()) {
      throw new Error(`Audit staging path is not a regular file: ${stagingPath}`)
    }
    owned = { identity: fileIdentity(info), path: stagingPath }
    const bytesWritten = await operations.write(handle, bytes)
    if (bytesWritten !== bytes.length) {
      throw new Error(
        `Incomplete staged audit line: wrote ${bytesWritten} of ${bytes.length} bytes`,
      )
    }
    await handle.close()
    return owned
  } catch (error) {
    await handle.close().catch(() => undefined)
    if (owned) {
      try {
        await unlinkOwnedPath(owned)
      } catch (cleanupError) {
        throw new AggregateError(
          [error, cleanupError],
          `Audit staging failed and cleanup was incomplete: ${stagingPath}`,
        )
      }
    }
    throw error
  }
}

async function moveIfPresent(
  sourcePath: string,
  destinationPath: string,
  operations: AuditStorageOperations,
): Promise<CompletedMove | null> {
  const source = await lstatBigintIfPresent(sourcePath)
  if (!source) return null
  if (await lstatBigintIfPresent(destinationPath)) {
    throw new Error(`Audit rotation destination already exists: ${destinationPath}`)
  }
  await operations.rename(sourcePath, destinationPath)
  return {
    identity: fileIdentity(source),
    path: destinationPath,
    sourcePath,
  }
}

async function rollbackMoves(
  completedMoves: CompletedMove[],
  operations: AuditStorageOperations,
): Promise<void> {
  for (const move of completedMoves.slice().reverse()) {
    const current = await lstatBigintIfPresent(move.path)
    if (!current || !sameIdentity(move.identity, current)) {
      throw new Error(`Cannot identify audit rollback source: ${move.path}`)
    }
    if (await lstatBigintIfPresent(move.sourcePath)) {
      throw new Error(`Audit rollback destination already exists: ${move.sourcePath}`)
    }
    await operations.rename(move.path, move.sourcePath)
  }
}

async function rotateAndCommitStagedLine(
  auditPath: string,
  bytes: Buffer,
  maxFiles: number,
  operations: AuditStorageOperations,
): Promise<void> {
  const transactionId = randomUUID()
  const staged = await createStagedAuditLine(auditPath, bytes, transactionId, operations)
  const rollbackPath = `${auditPath}.transaction-${transactionId}.rollback`
  const completedMoves: CompletedMove[] = []
  let droppedOldest: CompletedMove | null = null

  try {
    if (maxFiles === 1) {
      droppedOldest = await moveIfPresent(auditPath, rollbackPath, operations)
      if (droppedOldest) completedMoves.push(droppedOldest)
    } else {
      const oldestGeneration = maxFiles - 1
      droppedOldest = await moveIfPresent(
        auditGenerationPath(auditPath, oldestGeneration),
        rollbackPath,
        operations,
      )
      if (droppedOldest) completedMoves.push(droppedOldest)
      for (let generation = oldestGeneration - 1; generation >= 1; generation -= 1) {
        const move = await moveIfPresent(
          auditGenerationPath(auditPath, generation),
          auditGenerationPath(auditPath, generation + 1),
          operations,
        )
        if (move) completedMoves.push(move)
      }
      const activeMove = await moveIfPresent(
        auditPath,
        auditGenerationPath(auditPath, 1),
        operations,
      )
      if (activeMove) completedMoves.push(activeMove)
    }

    await operations.rename(staged.path, auditPath)
  } catch (error) {
    const rollbackErrors: unknown[] = []
    try {
      await rollbackMoves(completedMoves, operations)
    } catch (rollbackError) {
      rollbackErrors.push(rollbackError)
    }
    try {
      await unlinkOwnedPath(staged)
    } catch (cleanupError) {
      rollbackErrors.push(cleanupError)
    }
    if (rollbackErrors.length > 0) {
      throw new AggregateError(
        [error, ...rollbackErrors],
        `Audit rotation failed and rollback was incomplete: ${auditPath}`,
      )
    }
    throw error
  }

  if (droppedOldest) {
    await unlinkOwnedPath(droppedOldest)
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
  operationOverrides: Partial<AuditStorageOperations> = {},
): Promise<void> {
  if (!Number.isInteger(options.maxBytes) || options.maxBytes < 1) {
    throw new Error(`Audit maxBytes must be a positive integer: ${options.maxBytes}`)
  }
  if (
    !Number.isSafeInteger(options.maxFiles) ||
    options.maxFiles < 1 ||
    options.maxFiles > MAX_AUDIT_FILES
  ) {
    throw new Error(`Audit maxFiles must be an integer from 1 through 100: ${options.maxFiles}`)
  }

  const record = options.line.replace(/[\r\n]+$/u, '')
  const bytes = Buffer.from(`${record}\n`, 'utf8')
  const operations = resolveOperations(operationOverrides)

  await withAuditStorageLock(
    options.auditPath,
    async (auditPath) => {
      const active = await activeAuditSize(auditPath)
      if (active.exists && active.size + bytes.length > options.maxBytes) {
        await assertNotSymlink(auditPath, 'active audit log')
        await rotateAndCommitStagedLine(auditPath, bytes, options.maxFiles, operations)
        return
      }
      await appendCompleteLine(auditPath, bytes, operations)
    },
    operations,
  )
}
