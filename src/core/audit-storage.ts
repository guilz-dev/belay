import { randomUUID } from 'node:crypto'
import { constants, createReadStream } from 'node:fs'
import {
  type FileHandle,
  link,
  lstat,
  mkdir,
  open,
  readdir,
  rename,
  unlink,
} from 'node:fs/promises'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import type { Readable } from 'node:stream'
import { isAvailabilityCausedAsk } from './audit-availability.js'
import {
  AUDIT_READINESS_STATE_MAX_BYTES,
  type AuditReadinessStateSnapshot,
  type AuditReadinessStateV1,
  type AuditReadinessUpdate,
  auditRecordMatchesCohort,
  buildAuditReadinessState,
  isValidAuditReadinessTimestamp,
  parseAuditReadinessState,
  type RetainedAvailabilityEvidence,
  readinessStateMatchesCohort,
  validAuditReadinessUpdate,
} from './audit-readiness-state.js'
import type { AuditRecord } from './audit-types.js'
import { MAX_AUDIT_FILES } from './config.js'

export type {
  AuditReadinessStateSnapshot,
  AuditReadinessStateV1,
  AuditReadinessUpdate,
  RetainedAvailabilityEvidence,
} from './audit-readiness-state.js'
export {
  AUDIT_READINESS_STATE_SCHEMA_VERSION,
  auditBoundaryFingerprint,
} from './audit-readiness-state.js'

const AUDIT_LOCK_TIMEOUT_MS = 2_000
const AUDIT_LOCK_RETRY_DELAY_MS = 25
const AUDIT_LOCK_OWNER_MAX_BYTES = 1_024
const CARRIAGE_RETURN = Buffer.from('\r')
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu

export const MAX_AUDIT_RECORD_BYTES = 33_554_432

export interface AppendBoundedAuditLineOptions {
  auditPath: string
  line: string
  maxBytes: number
  maxFiles: number
  readinessUpdate?: AuditReadinessUpdate
  /** Legacy nested 0/0 retention disables rotation while retaining the canonical writer/lock. */
  rotationEnabled?: boolean
}

export interface AuditReadOptions {
  auditPath: string
  maxFiles: number
  maxLineBytes: number
}

export interface AuditLoadDiagnostics {
  filesRead: number
  bytesRead: number
  parsedRecords: number
  malformedLines: number
  oversizedLines: number
}

export interface AuditLoadResult {
  records: AuditRecord[]
  diagnostics: AuditLoadDiagnostics
  readinessState: AuditReadinessStateSnapshot
}

export interface AuditReadOperations {
  createReadStream(filePath: string, handle: FileHandle): Readable
}

export interface AuditStorageOperations {
  open(filePath: string, flags: number, mode: number): Promise<FileHandle>
  processLiveness(pid: number): 'alive' | 'absent' | 'unknown'
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
  ownerToken: string
}

interface AuditLockOwnerV1 {
  schemaVersion: 1
  pid: number
  ownerToken: string
  acquiredAt: string
}

interface OpenedAuditLockOwner {
  handle: FileHandle
  identity: FileIdentity
  owner: AuditLockOwnerV1
}

interface OwnedAuditPath {
  identity: FileIdentity
  path: string
}

interface CompletedMove extends OwnedAuditPath {
  sourcePath: string
}

interface OpenedRetainedAuditFile {
  handle: FileHandle
  identity: FileIdentity
  path: string
}

interface RetainedAuditSnapshot {
  files: OpenedRetainedAuditFile[]
  readinessState: AuditReadinessStateSnapshot
}

const DEFAULT_AUDIT_STORAGE_OPERATIONS: AuditStorageOperations = {
  open,
  processLiveness(pid) {
    try {
      process.kill(pid, 0)
      return 'alive'
    } catch (error) {
      if (errno(error) === 'ESRCH') return 'absent'
      if (errno(error) === 'EPERM') return 'alive'
      return 'unknown'
    }
  },
  rename,
  async write(handle, bytes) {
    const { bytesWritten } = await handle.write(bytes, 0, bytes.length, null)
    return bytesWritten
  },
}

const DEFAULT_AUDIT_READ_OPERATIONS: AuditReadOperations = {
  createReadStream(filePath, handle) {
    return createReadStream(filePath, { fd: handle, autoClose: false })
  },
}

function resolveOperations(overrides: Partial<AuditStorageOperations>): AuditStorageOperations {
  return { ...DEFAULT_AUDIT_STORAGE_OPERATIONS, ...overrides }
}

function resolveReadOperations(overrides: Partial<AuditReadOperations>): AuditReadOperations {
  return { ...DEFAULT_AUDIT_READ_OPERATIONS, ...overrides }
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

function validAuditLockOwner(value: unknown): value is AuditLockOwnerV1 {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  if (
    Object.keys(record).length !== 4 ||
    record.schemaVersion !== 1 ||
    !Number.isSafeInteger(record.pid) ||
    (record.pid as number) <= 0 ||
    typeof record.ownerToken !== 'string' ||
    !UUID_PATTERN.test(record.ownerToken) ||
    typeof record.acquiredAt !== 'string'
  ) {
    return false
  }
  const timestamp = Date.parse(record.acquiredAt)
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === record.acquiredAt
}

async function readAuditLockOwner(handle: FileHandle): Promise<AuditLockOwnerV1 | null> {
  try {
    const before = await handle.stat({ bigint: true })
    if (!before.isFile() || before.size < 1n || before.size > BigInt(AUDIT_LOCK_OWNER_MAX_BYTES)) {
      return null
    }
    const bytes = Buffer.alloc(AUDIT_LOCK_OWNER_MAX_BYTES + 1)
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0)
    const after = await handle.stat({ bigint: true })
    if (
      !sameIdentity(fileIdentity(before), after) ||
      after.size !== before.size ||
      bytesRead !== Number(before.size) ||
      bytesRead > AUDIT_LOCK_OWNER_MAX_BYTES
    ) {
      return null
    }
    const raw = bytes.subarray(0, bytesRead).toString('utf8')
    if (!raw.endsWith('\n') || raw.slice(0, -1).includes('\n')) return null
    const parsed: unknown = JSON.parse(raw.slice(0, -1))
    return validAuditLockOwner(parsed) ? parsed : null
  } catch {
    return null
  }
}

async function openAuditLockOwner(
  lockPath: string,
  operations: AuditStorageOperations,
): Promise<OpenedAuditLockOwner | null> {
  let handle: FileHandle | undefined
  try {
    const before = await lstat(lockPath, { bigint: true })
    if (before.isSymbolicLink() || !before.isFile()) return null
    const flags = constants.O_RDONLY | constants.O_NONBLOCK | noFollowFlag()
    handle = await operations.open(lockPath, flags, 0o600)
    const opened = await handle.stat({ bigint: true })
    const current = await lstat(lockPath, { bigint: true })
    const identity = fileIdentity(opened)
    if (
      !opened.isFile() ||
      current.isSymbolicLink() ||
      !current.isFile() ||
      !sameIdentity(fileIdentity(before), opened) ||
      !sameIdentity(identity, current)
    ) {
      return null
    }
    const owner = await readAuditLockOwner(handle)
    if (!owner) return null
    const result = { handle, identity, owner }
    handle = undefined
    return result
  } catch {
    return null
  } finally {
    await handle?.close().catch(() => undefined)
  }
}

async function removePathIfIdentityMatches(
  filePath: string,
  identity: FileIdentity,
): Promise<void> {
  try {
    const current = await lstat(filePath, { bigint: true })
    if (sameIdentity(identity, current)) await unlink(filePath)
  } catch (error) {
    if (errno(error) !== 'ENOENT') throw error
  }
}

async function createAuditLock(
  lockPath: string,
  flags: number,
  operations: AuditStorageOperations,
): Promise<AcquiredAuditLock> {
  const handle = await operations.open(lockPath, flags, 0o600)
  let identity: FileIdentity | undefined
  try {
    const created = await handle.stat({ bigint: true })
    if (!created.isFile()) throw new Error(`Audit lock path is not a regular file: ${lockPath}`)
    identity = fileIdentity(created)
    const owner: AuditLockOwnerV1 = {
      schemaVersion: 1,
      pid: process.pid,
      ownerToken: randomUUID(),
      acquiredAt: new Date().toISOString(),
    }
    const bytes = Buffer.from(`${JSON.stringify(owner)}\n`, 'utf8')
    if (bytes.length > AUDIT_LOCK_OWNER_MAX_BYTES) {
      throw new Error(`Audit lock owner exceeds ${AUDIT_LOCK_OWNER_MAX_BYTES} bytes`)
    }
    const bytesWritten = await operations.write(handle, bytes)
    if (bytesWritten !== bytes.length) {
      throw new Error(`Incomplete audit lock owner: wrote ${bytesWritten} of ${bytes.length} bytes`)
    }
    await handle.sync()
    const current = await lstat(lockPath, { bigint: true })
    if (current.isSymbolicLink() || !sameIdentity(identity, current)) {
      throw new Error(`Refusing replaced or symbolic link for audit lock: ${lockPath}`)
    }
    return { handle, identity, lockPath, ownerToken: owner.ownerToken }
  } catch (error) {
    await handle.close().catch(() => undefined)
    if (identity) await removePathIfIdentityMatches(lockPath, identity)
    throw error
  }
}

async function cleanForeignAuditReclaimClaim(
  lockPath: string,
  claimPath: string,
): Promise<boolean> {
  try {
    const claim = await lstat(claimPath, { bigint: true })
    const currentLock = await lstatBigintIfPresent(lockPath)
    if (currentLock && sameIdentity(fileIdentity(claim), currentLock)) return false
    await removePathIfIdentityMatches(claimPath, fileIdentity(claim))
    return true
  } catch (error) {
    if (errno(error) === 'ENOENT') return true
    return false
  }
}

async function recoverAbsentAuditLockOwner(
  lockPath: string,
  claimPath: string,
  operations: AuditStorageOperations,
): Promise<boolean> {
  const observed = await openAuditLockOwner(lockPath, operations)
  if (!observed) return false
  try {
    if (operations.processLiveness(observed.owner.pid) !== 'absent') return false
    try {
      await link(lockPath, claimPath)
    } catch (error) {
      if (errno(error) !== 'EEXIST') return false
      return cleanForeignAuditReclaimClaim(lockPath, claimPath)
    }

    let claim: OpenedAuditLockOwner | null = null
    let createdClaimIdentity: FileIdentity | undefined
    try {
      const createdClaim = await lstatBigintIfPresent(claimPath)
      if (!createdClaim) return false
      createdClaimIdentity = fileIdentity(createdClaim)
      claim = await openAuditLockOwner(claimPath, operations)
      if (!claim || !sameIdentity(observed.identity, claim.identity)) return false
      const currentLock = await lstatBigintIfPresent(lockPath)
      const currentClaim = await lstatBigintIfPresent(claimPath)
      if (
        !currentLock ||
        !currentClaim ||
        !sameIdentity(observed.identity, currentLock) ||
        !sameIdentity(observed.identity, currentClaim)
      ) {
        return false
      }
      const currentOwner = await readAuditLockOwner(observed.handle)
      if (
        !currentOwner ||
        currentOwner.ownerToken !== observed.owner.ownerToken ||
        claim.owner.ownerToken !== observed.owner.ownerToken ||
        claim.owner.pid !== observed.owner.pid
      ) {
        return false
      }
      if (operations.processLiveness(observed.owner.pid) !== 'absent') return false
      const finalLock = await lstatBigintIfPresent(lockPath)
      if (!finalLock || !sameIdentity(observed.identity, finalLock)) return false
      await unlink(lockPath)
      return true
    } finally {
      await claim?.handle.close().catch(() => undefined)
      if (createdClaimIdentity) {
        await removePathIfIdentityMatches(claimPath, createdClaimIdentity).catch(() => undefined)
      }
    }
  } finally {
    await observed.handle.close().catch(() => undefined)
  }
}

async function acquireAuditLock(
  lockPath: string,
  operations: AuditStorageOperations,
): Promise<AcquiredAuditLock> {
  const deadline = performance.now() + AUDIT_LOCK_TIMEOUT_MS
  const flags = constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | noFollowFlag()
  const claimPath = `${lockPath}.reclaim`

  for (;;) {
    try {
      return await createAuditLock(lockPath, flags, operations)
    } catch (error) {
      const code = errno(error)
      if (code !== 'EEXIST' && code !== 'ELOOP') throw error
      await assertNotSymlink(lockPath, 'audit lock')
      if (await recoverAbsentAuditLockOwner(lockPath, claimPath, operations)) continue
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

async function releaseAuditLock(
  lock: AcquiredAuditLock,
  operations: AuditStorageOperations,
): Promise<void> {
  let current: OpenedAuditLockOwner | null = null
  try {
    current = await openAuditLockOwner(lock.lockPath, operations)
    if (
      current &&
      sameIdentity(lock.identity, current.identity) &&
      current.owner.ownerToken === lock.ownerToken
    ) {
      await unlink(lock.lockPath)
    }
  } finally {
    await current?.handle.close().catch(() => undefined)
    await lock.handle.close().catch(() => undefined)
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
    await releaseAuditLock(lock, operations)
  }
}

export function auditGenerationPath(auditPath: string, generation: number): string {
  if (!Number.isInteger(generation) || generation < 1) {
    throw new Error(`Audit generation must be a positive integer: ${generation}`)
  }
  return `${path.resolve(auditPath)}.${generation}`
}

export function auditReadinessStatePath(auditPath: string): string {
  return `${path.resolve(auditPath)}.readiness.json`
}

async function loadAuditReadinessStateUnlocked(
  auditPath: string,
): Promise<AuditReadinessStateSnapshot> {
  const statePath = auditReadinessStatePath(auditPath)
  const before = await lstatBigintIfPresent(statePath)
  if (!before) return { status: 'missing' }
  if (
    before.isSymbolicLink() ||
    !before.isFile() ||
    before.size > BigInt(AUDIT_READINESS_STATE_MAX_BYTES)
  ) {
    return { status: 'invalid' }
  }

  let handle: FileHandle
  try {
    handle = await open(statePath, constants.O_RDONLY | noFollowFlag())
  } catch (error) {
    if (errno(error) === 'ENOENT') return { status: 'missing' }
    if (errno(error) === 'ELOOP') return { status: 'invalid' }
    throw error
  }
  try {
    const opened = await handle.stat({ bigint: true })
    const current = await lstatBigintIfPresent(statePath)
    if (
      !opened.isFile() ||
      opened.size > BigInt(AUDIT_READINESS_STATE_MAX_BYTES) ||
      !current ||
      current.isSymbolicLink() ||
      !sameIdentity(fileIdentity(opened), current)
    ) {
      return { status: 'invalid' }
    }
    const raw = await handle.readFile({ encoding: 'utf8' })
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      return { status: 'invalid' }
    }
    const state = parseAuditReadinessState(parsed)
    return state ? { status: 'valid', state } : { status: 'invalid' }
  } finally {
    await handle.close()
  }
}

function validateAuditReadOptions(options: AuditReadOptions): void {
  if (
    !Number.isSafeInteger(options.maxFiles) ||
    options.maxFiles < 1 ||
    options.maxFiles > MAX_AUDIT_FILES
  ) {
    throw new Error(`Audit maxFiles must be an integer from 1 through 100: ${options.maxFiles}`)
  }
  if (
    !Number.isSafeInteger(options.maxLineBytes) ||
    options.maxLineBytes < 1 ||
    options.maxLineBytes > MAX_AUDIT_RECORD_BYTES
  ) {
    throw new Error(
      `Audit maxLineBytes must be a positive integer no greater than ${MAX_AUDIT_RECORD_BYTES}: ${options.maxLineBytes}`,
    )
  }
}

function emptyAuditLoadDiagnostics(): AuditLoadDiagnostics {
  return {
    filesRead: 0,
    bytesRead: 0,
    parsedRecords: 0,
    malformedLines: 0,
    oversizedLines: 0,
  }
}

function parseAuditRecordBytes(
  buffer: Buffer | undefined,
  length: number,
  diagnostics: AuditLoadDiagnostics,
): AuditRecord | null {
  if (!buffer || length === 0) {
    return null
  }
  const trimmed = buffer.subarray(0, length).toString('utf8').trim()
  if (!trimmed) {
    return null
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed)
  } catch {
    diagnostics.malformedLines += 1
    return null
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    diagnostics.malformedLines += 1
    return null
  }
  diagnostics.parsedRecords += 1
  return parsed as AuditRecord
}

async function openRetainedAuditSnapshotUnlocked(
  options: AuditReadOptions,
): Promise<RetainedAuditSnapshot> {
  const auditPath = path.resolve(options.auditPath)
  const retainedPaths: string[] = []
  for (let generation = options.maxFiles - 1; generation >= 1; generation -= 1) {
    retainedPaths.push(auditGenerationPath(auditPath, generation))
  }
  retainedPaths.push(auditPath)
  const files: OpenedRetainedAuditFile[] = []
  try {
    for (const retainedPath of retainedPaths) {
      const before = await lstatBigintIfPresent(retainedPath)
      if (!before) continue
      if (before.isSymbolicLink()) {
        throw new Error(`Refusing symbolic link for retained audit log: ${retainedPath}`)
      }
      if (!before.isFile()) {
        throw new Error(`Retained audit path is not a regular file: ${retainedPath}`)
      }

      let handle: FileHandle
      try {
        handle = await open(retainedPath, constants.O_RDONLY | noFollowFlag())
      } catch (error) {
        if (errno(error) === 'ENOENT') continue
        throw error
      }
      const opened = await handle.stat({ bigint: true })
      const current = await lstatBigintIfPresent(retainedPath)
      const identity = fileIdentity(opened)
      if (
        !opened.isFile() ||
        !current ||
        current.isSymbolicLink() ||
        !sameIdentity(identity, current)
      ) {
        await handle.close()
        throw new Error(`Retained audit path changed while opening snapshot: ${retainedPath}`)
      }
      files.push({ handle, identity, path: retainedPath })
    }
    return {
      files,
      readinessState: await loadAuditReadinessStateUnlocked(auditPath),
    }
  } catch (error) {
    await Promise.all(files.map(({ handle }) => handle.close().catch(() => undefined)))
    throw error
  }
}

async function openRetainedAuditSnapshot(
  options: AuditReadOptions,
): Promise<RetainedAuditSnapshot> {
  return withAuditStorageLock(options.auditPath, (auditPath) =>
    openRetainedAuditSnapshotUnlocked({ ...options, auditPath }),
  )
}

async function* iterateOpenedAuditRecords(
  snapshot: RetainedAuditSnapshot,
  options: AuditReadOptions,
  operations: AuditReadOperations,
  strict = false,
): AsyncGenerator<AuditRecord, AuditLoadDiagnostics, void> {
  const diagnostics = emptyAuditLoadDiagnostics()
  let lineBuffer: Buffer | undefined
  const openHandles = new Set(snapshot.files.map(({ handle }) => handle))
  try {
    for (const retained of snapshot.files) {
      const { handle, path: retainedPath } = retained
      diagnostics.filesRead += 1
      const stream = operations.createReadStream(retainedPath, handle)
      let lineLength = 0
      let pendingCarriageReturn = false
      let discardingOversizedLine = false

      const discardOversizedLine = (): void => {
        if (!discardingOversizedLine) {
          diagnostics.oversizedLines += 1
        }
        discardingOversizedLine = true
        lineLength = 0
        pendingCarriageReturn = false
      }

      const appendLineBytes = (source: Buffer, start = 0, end = source.length): void => {
        const byteLength = end - start
        if (byteLength === 0) {
          return
        }
        if (lineLength + byteLength > options.maxLineBytes) {
          discardOversizedLine()
          return
        }
        lineBuffer ??= Buffer.allocUnsafe(options.maxLineBytes)
        source.copy(lineBuffer, lineLength, start, end)
        lineLength += byteLength
      }

      try {
        for await (const rawChunk of stream) {
          const chunk = Buffer.isBuffer(rawChunk) ? rawChunk : Buffer.from(rawChunk as Uint8Array)
          diagnostics.bytesRead += chunk.length
          let offset = 0

          while (offset < chunk.length) {
            const newlineIndex = chunk.indexOf(0x0a, offset)
            const hasNewline = newlineIndex !== -1
            const segmentEnd = hasNewline ? newlineIndex : chunk.length

            if (discardingOversizedLine) {
              if (!hasNewline) {
                break
              }
              discardingOversizedLine = false
              offset = newlineIndex + 1
              continue
            }

            if (pendingCarriageReturn) {
              pendingCarriageReturn = false
              if (!(hasNewline && segmentEnd === offset)) {
                appendLineBytes(CARRIAGE_RETURN)
              }
            }

            if (!discardingOversizedLine) {
              let contentEnd = segmentEnd
              if (contentEnd > offset && chunk[contentEnd - 1] === 0x0d) {
                contentEnd -= 1
                if (!hasNewline) {
                  pendingCarriageReturn = true
                }
              }
              appendLineBytes(chunk, offset, contentEnd)
            }

            if (!hasNewline) {
              break
            }

            if (!discardingOversizedLine) {
              const record = parseAuditRecordBytes(lineBuffer, lineLength, diagnostics)
              if (record) {
                yield record
              }
            }
            lineLength = 0
            pendingCarriageReturn = false
            discardingOversizedLine = false
            offset = newlineIndex + 1
          }
        }

        if (strict && (discardingOversizedLine || pendingCarriageReturn || lineLength > 0)) {
          throw new Error(`Truncated retained audit line: ${retainedPath}`)
        }

        if (!discardingOversizedLine) {
          if (pendingCarriageReturn) {
            appendLineBytes(CARRIAGE_RETURN)
          }
          if (!discardingOversizedLine) {
            const record = parseAuditRecordBytes(lineBuffer, lineLength, diagnostics)
            if (record) {
              yield record
            }
          }
        }
        if (strict) {
          const current = await lstatBigintIfPresent(retainedPath)
          if (!current || current.isSymbolicLink() || !sameIdentity(retained.identity, current)) {
            throw new Error(`Retained audit path changed while reading snapshot: ${retainedPath}`)
          }
        }
      } finally {
        stream.destroy()
        openHandles.delete(handle)
        await handle.close()
      }
    }
  } finally {
    await Promise.all([...openHandles].map((handle) => handle.close().catch(() => undefined)))
  }

  return diagnostics
}

/**
 * Read exact retained generations oldest-to-active from file handles fixed under the writer lock.
 *
 * The generator return value contains diagnostics for a fully consumed stream. Blank lines affect
 * no line counters; malformed, non-object, and oversized lines never become audit evidence.
 */
export async function* iterateAuditRecords(
  options: AuditReadOptions,
  operationOverrides: Partial<AuditReadOperations> = {},
): AsyncGenerator<AuditRecord, AuditLoadDiagnostics, void> {
  validateAuditReadOptions(options)
  const snapshot = await openRetainedAuditSnapshot(options)
  const iterator = iterateOpenedAuditRecords(
    snapshot,
    options,
    resolveReadOperations(operationOverrides),
  )
  let completed = false
  try {
    for (;;) {
      const next = await iterator.next()
      if (next.done) {
        completed = true
        return next.value
      }
      yield next.value
    }
  } finally {
    if (!completed) {
      await iterator.return(emptyAuditLoadDiagnostics())
    }
  }
}

/** Collect the bounded retained-generation iterator for aggregation-oriented consumers. */
export async function loadRetainedAuditRecords(
  options: AuditReadOptions,
  operationOverrides: Partial<AuditReadOperations> = {},
): Promise<AuditLoadResult> {
  validateAuditReadOptions(options)
  const records: AuditRecord[] = []
  const snapshot = await openRetainedAuditSnapshot(options)
  const iterator = iterateOpenedAuditRecords(
    snapshot,
    options,
    resolveReadOperations(operationOverrides),
  )
  for (;;) {
    const next = await iterator.next()
    if (next.done) {
      return { records, diagnostics: next.value, readinessState: snapshot.readinessState }
    }
    records.push(next.value)
  }
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

async function pruneExcessAuditGenerations(auditPath: string, maxFiles: number): Promise<void> {
  let entries: string[]
  try {
    entries = await readdir(path.dirname(auditPath))
  } catch (error) {
    if (errno(error) === 'ENOENT') return
    throw error
  }
  const escapedName = path.basename(auditPath).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const generationPattern = new RegExp(`^${escapedName}\\.(\\d+)$`)
  const excess = entries
    .map((entry) => {
      const match = entry.match(generationPattern)
      return match ? { entry, generation: Number(match[1]) } : null
    })
    .filter(
      (candidate): candidate is { entry: string; generation: number } =>
        candidate !== null &&
        Number.isSafeInteger(candidate.generation) &&
        candidate.generation >= maxFiles,
    )
    .sort((left, right) => right.generation - left.generation)

  for (const candidate of excess) {
    const generationPath = path.join(path.dirname(auditPath), candidate.entry)
    const info = await lstatBigintIfPresent(generationPath)
    if (!info) continue
    if (info.isSymbolicLink() || !info.isFile()) {
      throw new Error(`Refusing non-regular excess audit generation: ${generationPath}`)
    }
    await unlinkOwnedPath({ identity: fileIdentity(info), path: generationPath })
  }
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

async function writeAuditReadinessStateAtomic(
  auditPath: string,
  state: AuditReadinessStateV1,
  operations: AuditStorageOperations,
): Promise<void> {
  const statePath = auditReadinessStatePath(auditPath)
  const bytes = Buffer.from(`${JSON.stringify(state)}\n`, 'utf8')
  if (bytes.length > AUDIT_READINESS_STATE_MAX_BYTES) {
    throw new Error(`Audit readiness state exceeds ${AUDIT_READINESS_STATE_MAX_BYTES} bytes`)
  }
  await assertNotSymlink(statePath, 'audit readiness state')
  const staged = await createStagedAuditLine(statePath, bytes, randomUUID(), operations)
  try {
    await assertNotSymlink(statePath, 'audit readiness state')
    await operations.rename(staged.path, statePath)
  } catch (error) {
    try {
      await unlinkOwnedPath(staged)
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        `Audit readiness state write failed and cleanup was incomplete: ${statePath}`,
      )
    }
    throw error
  }
}

function retainedAvailabilityEvidence(state: AuditReadinessStateV1): RetainedAvailabilityEvidence {
  return {
    availabilityAskCount: state.availabilityAskCount,
    ...(state.firstAvailabilityAt ? { firstAvailabilityAt: state.firstAvailabilityAt } : {}),
    ...(state.lastAvailabilityAt ? { lastAvailabilityAt: state.lastAvailabilityAt } : {}),
  }
}

async function reconstructRetainedAvailabilityEvidence(
  auditPath: string,
  maxFiles: number,
  update: AuditReadinessUpdate,
): Promise<RetainedAvailabilityEvidence> {
  const options = { auditPath, maxFiles, maxLineBytes: MAX_AUDIT_RECORD_BYTES }
  const snapshot = await openRetainedAuditSnapshotUnlocked(options)
  const iterator = iterateOpenedAuditRecords(snapshot, options, DEFAULT_AUDIT_READ_OPERATIONS, true)
  let availabilityAskCount = 0
  let firstAvailabilityAt: string | undefined
  let lastAvailabilityAt: string | undefined
  let completed = false
  try {
    for (;;) {
      const next = await iterator.next()
      if (next.done) {
        completed = true
        if (next.value.malformedLines > 0) {
          throw new Error('Malformed retained audit evidence prevents readiness reconstruction')
        }
        if (next.value.oversizedLines > 0) {
          throw new Error('Oversized retained audit evidence prevents readiness reconstruction')
        }
        break
      }
      const record = next.value
      if (!auditRecordMatchesCohort(record, update.cohort) || !isAvailabilityCausedAsk(record)) {
        continue
      }
      if (!isValidAuditReadinessTimestamp(record.timestamp)) {
        throw new Error('Malformed retained audit timestamp prevents readiness reconstruction')
      }
      availabilityAskCount = Math.min(Number.MAX_SAFE_INTEGER, availabilityAskCount + 1)
      firstAvailabilityAt ??= record.timestamp
      lastAvailabilityAt = record.timestamp
    }
  } finally {
    if (!completed) {
      await iterator.return(emptyAuditLoadDiagnostics())
    }
  }
  return {
    availabilityAskCount,
    ...(firstAvailabilityAt ? { firstAvailabilityAt } : {}),
    ...(lastAvailabilityAt ? { lastAvailabilityAt } : {}),
  }
}

async function updateAuditReadinessState(
  auditPath: string,
  maxFiles: number,
  update: AuditReadinessUpdate,
  operations: AuditStorageOperations,
): Promise<void> {
  if (!validAuditReadinessUpdate(update)) {
    throw new Error('Audit readiness update requires a valid decision cohort and timestamp')
  }
  const current = await loadAuditReadinessStateUnlocked(auditPath)
  const retainedState =
    current.status === 'valid' && readinessStateMatchesCohort(current.state, update.cohort)
      ? current.state
      : undefined
  if (retainedState && !update.availabilityCausedAsk) {
    return
  }
  const evidence = retainedState
    ? retainedAvailabilityEvidence(retainedState)
    : await reconstructRetainedAvailabilityEvidence(auditPath, maxFiles, update)
  const next = buildAuditReadinessState(update, evidence)
  await writeAuditReadinessStateAtomic(auditPath, next, operations)
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
 * Compatibility hook for the pre-append rotation API introduced on main.
 *
 * Rotation still runs through this module's symlink-safe lock and transactional generation
 * mover; callers do not gain a second writer implementation.
 */
export async function maybeRotateBoundedAuditLog(
  options: Pick<AppendBoundedAuditLineOptions, 'auditPath' | 'maxBytes' | 'maxFiles'> & {
    incomingBytes?: number
  },
  operationOverrides: Partial<AuditStorageOperations> = {},
): Promise<boolean> {
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
  const incomingBytes = options.incomingBytes ?? 0
  if (!Number.isSafeInteger(incomingBytes) || incomingBytes < 0) {
    throw new Error(`Audit incomingBytes must be a non-negative safe integer: ${incomingBytes}`)
  }

  const operations = resolveOperations(operationOverrides)
  return withAuditStorageLock(
    options.auditPath,
    async (auditPath) => {
      await pruneExcessAuditGenerations(auditPath, options.maxFiles)
      const active = await activeAuditSize(auditPath)
      if (!active.exists || active.size === 0 || active.size + incomingBytes <= options.maxBytes) {
        return false
      }
      await assertNotSymlink(auditPath, 'active audit log')
      await rotateAndCommitStagedLine(auditPath, Buffer.alloc(0), options.maxFiles, operations)
      return true
    },
    operations,
  )
}

/**
 * Append one already serialized NDJSON record under a sibling lock.
 *
 * A single record may exceed maxBytes up to MAX_AUDIT_RECORD_BYTES. It remains whole and becomes
 * the active file after any applicable rotation; maxBytes is a rotation threshold, not a record
 * truncation limit.
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
  const completeLineBytes = Buffer.byteLength(record, 'utf8') + 1
  if (completeLineBytes > MAX_AUDIT_RECORD_BYTES) {
    throw new Error(
      `Audit record exceeds the fixed ${MAX_AUDIT_RECORD_BYTES}-byte complete line limit: ${completeLineBytes}`,
    )
  }
  const bytes = Buffer.from(`${record}\n`, 'utf8')
  const operations = resolveOperations(operationOverrides)

  await withAuditStorageLock(
    options.auditPath,
    async (auditPath) => {
      if (options.readinessUpdate) {
        await updateAuditReadinessState(
          auditPath,
          options.maxFiles,
          options.readinessUpdate,
          operations,
        )
      }
      if (options.rotationEnabled !== false) {
        await pruneExcessAuditGenerations(auditPath, options.maxFiles)
      }
      const active = await activeAuditSize(auditPath)
      if (
        options.rotationEnabled !== false &&
        active.exists &&
        active.size + bytes.length > options.maxBytes
      ) {
        await assertNotSymlink(auditPath, 'active audit log')
        await rotateAndCommitStagedLine(auditPath, bytes, options.maxFiles, operations)
        return
      }
      await appendCompleteLine(auditPath, bytes, operations)
    },
    operations,
  )
}
