import { createHash, randomUUID } from 'node:crypto'
import { constants, createReadStream } from 'node:fs'
import { type FileHandle, lstat, mkdir, open, rename, unlink } from 'node:fs/promises'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import type { Readable } from 'node:stream'
import type { AuditRecord } from './audit-types.js'
import { MAX_AUDIT_FILES } from './config.js'

const AUDIT_LOCK_TIMEOUT_MS = 2_000
const AUDIT_LOCK_RETRY_DELAY_MS = 25
const AUDIT_READINESS_STATE_MAX_BYTES = 4_096
const CARRIAGE_RETURN = Buffer.from('\r')
const HEX64_PATTERN = /^[a-f0-9]{64}$/
const ISO8601_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/

export const MAX_AUDIT_RECORD_BYTES = 33_554_432
export const AUDIT_READINESS_STATE_SCHEMA_VERSION = 1

export interface AuditReadinessUpdate {
  runtimeArtifactHash: string
  decisionConfigFingerprint: string
  boundaryProfile: string
  availabilityCausedAsk: boolean
  timestamp: string
}

export interface AuditReadinessStateV1 {
  schemaVersion: typeof AUDIT_READINESS_STATE_SCHEMA_VERSION
  cohort: {
    runtimeArtifactHash: string
    decisionConfigFingerprint: string
    boundaryFingerprint: string
  }
  availabilityAskCount: number
  firstAvailabilityAt?: string
  lastAvailabilityAt?: string
  updatedAt: string
}

export type AuditReadinessStateSnapshot =
  | { status: 'missing' }
  | { status: 'invalid' }
  | { status: 'valid'; state: AuditReadinessStateV1 }

export interface AppendBoundedAuditLineOptions {
  auditPath: string
  line: string
  maxBytes: number
  maxFiles: number
  readinessUpdate?: AuditReadinessUpdate
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

interface OpenedRetainedAuditFile {
  handle: FileHandle
  path: string
}

interface RetainedAuditSnapshot {
  files: OpenedRetainedAuditFile[]
  readinessState: AuditReadinessStateSnapshot
}

const DEFAULT_AUDIT_STORAGE_OPERATIONS: AuditStorageOperations = {
  open,
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

export function auditReadinessStatePath(auditPath: string): string {
  return `${path.resolve(auditPath)}.readiness.json`
}

export function auditBoundaryFingerprint(boundaryProfile: string): string {
  return createHash('sha256').update(boundaryProfile).digest('hex')
}

function validAuditReadinessUpdate(update: AuditReadinessUpdate): boolean {
  return (
    HEX64_PATTERN.test(update.runtimeArtifactHash) &&
    HEX64_PATTERN.test(update.decisionConfigFingerprint) &&
    update.boundaryProfile.length > 0 &&
    Buffer.byteLength(update.boundaryProfile, 'utf8') <= 1_024 &&
    typeof update.availabilityCausedAsk === 'boolean' &&
    ISO8601_PATTERN.test(update.timestamp)
  )
}

function parseAuditReadinessState(value: unknown): AuditReadinessStateV1 | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null
  }
  const candidate = value as Record<string, unknown>
  const cohort = candidate.cohort
  if (!cohort || typeof cohort !== 'object' || Array.isArray(cohort)) {
    return null
  }
  const cohortRecord = cohort as Record<string, unknown>
  const runtimeArtifactHash = cohortRecord.runtimeArtifactHash
  const decisionConfigFingerprint = cohortRecord.decisionConfigFingerprint
  const boundaryFingerprint = cohortRecord.boundaryFingerprint
  const availabilityAskCount = candidate.availabilityAskCount
  const updatedAt = candidate.updatedAt
  const firstAvailabilityAt = candidate.firstAvailabilityAt
  const lastAvailabilityAt = candidate.lastAvailabilityAt
  if (
    candidate.schemaVersion !== AUDIT_READINESS_STATE_SCHEMA_VERSION ||
    typeof runtimeArtifactHash !== 'string' ||
    !HEX64_PATTERN.test(runtimeArtifactHash) ||
    typeof decisionConfigFingerprint !== 'string' ||
    !HEX64_PATTERN.test(decisionConfigFingerprint) ||
    typeof boundaryFingerprint !== 'string' ||
    !HEX64_PATTERN.test(boundaryFingerprint) ||
    !Number.isSafeInteger(availabilityAskCount) ||
    (availabilityAskCount as number) < 0 ||
    typeof updatedAt !== 'string' ||
    !ISO8601_PATTERN.test(updatedAt) ||
    (firstAvailabilityAt !== undefined &&
      (typeof firstAvailabilityAt !== 'string' || !ISO8601_PATTERN.test(firstAvailabilityAt))) ||
    (lastAvailabilityAt !== undefined &&
      (typeof lastAvailabilityAt !== 'string' || !ISO8601_PATTERN.test(lastAvailabilityAt)))
  ) {
    return null
  }
  if (
    ((availabilityAskCount as number) === 0 &&
      (firstAvailabilityAt !== undefined || lastAvailabilityAt !== undefined)) ||
    ((availabilityAskCount as number) > 0 &&
      (firstAvailabilityAt === undefined || lastAvailabilityAt === undefined))
  ) {
    return null
  }
  return {
    schemaVersion: AUDIT_READINESS_STATE_SCHEMA_VERSION,
    cohort: {
      runtimeArtifactHash,
      decisionConfigFingerprint,
      boundaryFingerprint,
    },
    availabilityAskCount: availabilityAskCount as number,
    ...(typeof firstAvailabilityAt === 'string' ? { firstAvailabilityAt } : {}),
    ...(typeof lastAvailabilityAt === 'string' ? { lastAvailabilityAt } : {}),
    updatedAt,
  }
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

async function openRetainedAuditSnapshot(
  options: AuditReadOptions,
): Promise<RetainedAuditSnapshot> {
  const auditPath = path.resolve(options.auditPath)
  return withAuditStorageLock(auditPath, async (resolvedAuditPath) => {
    const retainedPaths: string[] = []
    for (let generation = options.maxFiles - 1; generation >= 1; generation -= 1) {
      retainedPaths.push(auditGenerationPath(resolvedAuditPath, generation))
    }
    retainedPaths.push(resolvedAuditPath)
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
        if (
          !opened.isFile() ||
          !current ||
          current.isSymbolicLink() ||
          !sameIdentity(fileIdentity(opened), current)
        ) {
          await handle.close()
          throw new Error(`Retained audit path changed while opening snapshot: ${retainedPath}`)
        }
        files.push({ handle, path: retainedPath })
      }
      return {
        files,
        readinessState: await loadAuditReadinessStateUnlocked(resolvedAuditPath),
      }
    } catch (error) {
      await Promise.all(files.map(({ handle }) => handle.close().catch(() => undefined)))
      throw error
    }
  })
}

async function* iterateOpenedAuditRecords(
  snapshot: RetainedAuditSnapshot,
  options: AuditReadOptions,
  operations: AuditReadOperations,
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

function sameReadinessCohort(state: AuditReadinessStateV1, update: AuditReadinessUpdate): boolean {
  return (
    state.cohort.runtimeArtifactHash === update.runtimeArtifactHash &&
    state.cohort.decisionConfigFingerprint === update.decisionConfigFingerprint &&
    state.cohort.boundaryFingerprint === auditBoundaryFingerprint(update.boundaryProfile)
  )
}

async function updateAuditReadinessState(
  auditPath: string,
  update: AuditReadinessUpdate,
  operations: AuditStorageOperations,
): Promise<void> {
  if (!validAuditReadinessUpdate(update)) {
    throw new Error('Audit readiness update requires a valid decision cohort and timestamp')
  }
  const current = await loadAuditReadinessStateUnlocked(auditPath)
  const retainedState =
    current.status === 'valid' && sameReadinessCohort(current.state, update)
      ? current.state
      : undefined
  if (retainedState && !update.availabilityCausedAsk) {
    return
  }

  const previousCount = retainedState?.availabilityAskCount ?? 0
  const availabilityAskCount = update.availabilityCausedAsk
    ? Math.min(Number.MAX_SAFE_INTEGER, previousCount + 1)
    : 0
  const next: AuditReadinessStateV1 = {
    schemaVersion: AUDIT_READINESS_STATE_SCHEMA_VERSION,
    cohort: {
      runtimeArtifactHash: update.runtimeArtifactHash,
      decisionConfigFingerprint: update.decisionConfigFingerprint,
      boundaryFingerprint: auditBoundaryFingerprint(update.boundaryProfile),
    },
    availabilityAskCount,
    ...(availabilityAskCount > 0
      ? {
          firstAvailabilityAt: retainedState?.firstAvailabilityAt ?? update.timestamp,
          lastAvailabilityAt: update.timestamp,
        }
      : {}),
    updatedAt: update.timestamp,
  }
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
        await updateAuditReadinessState(auditPath, options.readinessUpdate, operations)
      }
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
