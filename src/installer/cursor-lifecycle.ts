import { randomUUID } from 'node:crypto'
import { appendFile, mkdir, open, readFile, realpath, rename, rm, stat } from 'node:fs/promises'
import path from 'node:path'

import {
  canonicalizePotentialPath,
  type InstallScope,
  type ScopedPaths,
} from '../adapters/layouts/scope.js'

const LOCK_DIRECTORY_NAME = '.belay-lifecycle.lock'
const DISABLE_MARKER_NAME = 'belay.disabled.json'
const LIFECYCLE_LOG_NAME = 'belay-lifecycle.ndjson'

export interface CursorLifecyclePaths {
  ownerDir: string
  lockDir: string
  lockOwnerPath: string
  disableMarkerPath: string
  logPath: string
}

export interface CursorLifecycleMetadata {
  operation: string
  repoRoot: string
  scope: InstallScope
}

export interface CursorLifecycleEvent extends CursorLifecycleMetadata {
  schemaVersion: 1
  operationId: string
  pid: number
  at: string
  phase: 'start' | 'result'
  outcome?: 'success' | 'failure'
  error?: string
}

export interface CursorDisableMarker {
  schemaVersion: 1
  operationId: string
  pid: number
  scope: 'project' | 'global'
  repoRoot: string
  disabledAt: string
}

interface CursorLockOwner extends CursorLifecycleMetadata {
  schemaVersion: 1
  operationId: string
  pid: number
  token: string
  acquiredAt: string
  lockDir: string
}

interface CursorLifecycleLockOptions {
  timeoutMs?: number
  retryMs?: number
}

function isErrno(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && error.code === code
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

function isPidAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) {
    return true
  }
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return !isErrno(error, 'ESRCH')
  }
}

export function cursorLifecyclePaths(paths: ScopedPaths): CursorLifecyclePaths {
  const ownerDir = canonicalizePotentialPath(path.dirname(paths.hooksSettingsPath))
  const lockDir = path.join(ownerDir, LOCK_DIRECTORY_NAME)
  return {
    ownerDir,
    lockDir,
    lockOwnerPath: path.join(lockDir, 'owner.json'),
    disableMarkerPath: path.join(ownerDir, DISABLE_MARKER_NAME),
    logPath: path.join(ownerDir, LIFECYCLE_LOG_NAME),
  }
}

export function cursorLifecycleLockPaths(paths: ScopedPaths[]): string[] {
  return [...new Set(paths.map((entry) => cursorLifecyclePaths(entry).lockDir))].sort()
}

export async function writeJsonAtomic(filePath: string, value: unknown): Promise<void> {
  let destination = canonicalizePotentialPath(filePath)
  try {
    destination = await realpath(filePath)
  } catch (error) {
    if (!isErrno(error, 'ENOENT')) {
      throw error
    }
  }
  await mkdir(path.dirname(destination), { recursive: true })
  const temporaryPath = path.join(
    path.dirname(destination),
    `.${path.basename(destination)}.${process.pid}.${randomUUID()}.tmp`,
  )
  let handle: Awaited<ReturnType<typeof open>> | undefined
  try {
    handle = await open(temporaryPath, 'wx', 0o600)
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, 'utf8')
    await handle.sync()
    await handle.close()
    handle = undefined
    await rename(temporaryPath, destination)
  } finally {
    await handle?.close()
    await rm(temporaryPath, { force: true })
  }
}

async function readLockOwner(lockOwnerPath: string): Promise<Partial<CursorLockOwner> | null> {
  try {
    const value = JSON.parse(await readFile(lockOwnerPath, 'utf8')) as unknown
    return value !== null && typeof value === 'object' ? (value as Partial<CursorLockOwner>) : null
  } catch {
    return null
  }
}

async function recoverDeadLock(lockDir: string): Promise<boolean> {
  const owner = await readLockOwner(path.join(lockDir, 'owner.json'))
  if (!owner || typeof owner.pid !== 'number' || isPidAlive(owner.pid)) {
    return false
  }
  const stalePath = `${lockDir}.stale.${process.pid}.${randomUUID()}`
  try {
    await rename(lockDir, stalePath)
  } catch (error) {
    if (isErrno(error, 'ENOENT')) {
      return true
    }
    return false
  }
  await rm(stalePath, { recursive: true, force: true })
  return true
}

async function acquireLock(
  lockDir: string,
  metadata: CursorLifecycleMetadata,
  operationId: string,
  options: CursorLifecycleLockOptions,
): Promise<CursorLockOwner> {
  const timeoutMs = options.timeoutMs ?? 10_000
  const retryMs = options.retryMs ?? 50
  const deadline = Date.now() + timeoutMs
  await mkdir(path.dirname(lockDir), { recursive: true })

  while (true) {
    const owner: CursorLockOwner = {
      schemaVersion: 1,
      operationId,
      pid: process.pid,
      token: randomUUID(),
      acquiredAt: new Date().toISOString(),
      lockDir,
      ...metadata,
    }
    try {
      await mkdir(lockDir)
      try {
        await writeJsonAtomic(path.join(lockDir, 'owner.json'), owner)
        return owner
      } catch (error) {
        await rm(lockDir, { recursive: true, force: true })
        throw error
      }
    } catch (error) {
      if (!isErrno(error, 'EEXIST')) {
        throw error
      }
    }

    if (await recoverDeadLock(lockDir)) {
      continue
    }
    if (Date.now() >= deadline) {
      throw new Error(`Cursor lifecycle lock acquisition timed out: ${lockDir}`)
    }
    await delay(Math.min(retryMs, Math.max(1, deadline - Date.now())))
  }
}

async function releaseLock(owner: CursorLockOwner): Promise<void> {
  const current = await readLockOwner(path.join(owner.lockDir, 'owner.json'))
  if (current?.token !== owner.token) {
    return
  }
  await rm(owner.lockDir, { recursive: true, force: true })
}

export async function appendCursorLifecycleEvent(
  paths: ScopedPaths,
  event: CursorLifecycleEvent,
): Promise<void> {
  const { logPath } = cursorLifecyclePaths(paths)
  await mkdir(path.dirname(logPath), { recursive: true })
  await appendFile(logPath, `${JSON.stringify(event)}\n`, { encoding: 'utf8', flag: 'a' })
}

function uniqueOwners(paths: ScopedPaths[]): ScopedPaths[] {
  const byLockPath = new Map<string, ScopedPaths>()
  for (const entry of paths) {
    byLockPath.set(cursorLifecyclePaths(entry).lockDir, entry)
  }
  return [...byLockPath.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([, entry]) => entry)
}

export async function withCursorLifecycleLocks<T>(
  paths: ScopedPaths[],
  metadata: CursorLifecycleMetadata,
  action: (context: { operationId: string }) => Promise<T>,
  options: CursorLifecycleLockOptions = {},
): Promise<T> {
  const operationId = randomUUID()
  const owners = uniqueOwners(paths)
  const locks: CursorLockOwner[] = []
  try {
    for (const ownerPaths of owners) {
      locks.push(
        await acquireLock(cursorLifecyclePaths(ownerPaths).lockDir, metadata, operationId, options),
      )
    }
    const start: CursorLifecycleEvent = {
      schemaVersion: 1,
      operationId,
      pid: process.pid,
      at: new Date().toISOString(),
      phase: 'start',
      ...metadata,
    }
    await Promise.all(owners.map((ownerPaths) => appendCursorLifecycleEvent(ownerPaths, start)))
    try {
      const result = await action({ operationId })
      const success: CursorLifecycleEvent = {
        ...start,
        at: new Date().toISOString(),
        phase: 'result',
        outcome: 'success',
      }
      await Promise.all(owners.map((ownerPaths) => appendCursorLifecycleEvent(ownerPaths, success)))
      return result
    } catch (error) {
      const failure: CursorLifecycleEvent = {
        ...start,
        at: new Date().toISOString(),
        phase: 'result',
        outcome: 'failure',
        error: error instanceof Error ? error.message : String(error),
      }
      await Promise.all(owners.map((ownerPaths) => appendCursorLifecycleEvent(ownerPaths, failure)))
      throw error
    }
  } finally {
    for (const owner of locks.reverse()) {
      await releaseLock(owner)
    }
  }
}

export async function writeCursorDisableMarker(
  paths: ScopedPaths,
  input: Pick<CursorDisableMarker, 'operationId' | 'repoRoot' | 'scope'>,
): Promise<CursorDisableMarker> {
  const marker: CursorDisableMarker = {
    schemaVersion: 1,
    operationId: input.operationId,
    pid: process.pid,
    scope: input.scope,
    repoRoot: input.repoRoot,
    disabledAt: new Date().toISOString(),
  }
  await writeJsonAtomic(cursorLifecyclePaths(paths).disableMarkerPath, marker)
  return marker
}

export async function readCursorDisableMarker(
  paths: ScopedPaths,
): Promise<CursorDisableMarker | null> {
  const markerPath = cursorLifecyclePaths(paths).disableMarkerPath
  let raw: string
  try {
    raw = await readFile(markerPath, 'utf8')
  } catch (error) {
    if (isErrno(error, 'ENOENT')) {
      return null
    }
    throw error
  }
  const value = JSON.parse(raw) as Partial<CursorDisableMarker>
  if (
    value.schemaVersion !== 1 ||
    typeof value.operationId !== 'string' ||
    typeof value.pid !== 'number' ||
    (value.scope !== 'project' && value.scope !== 'global') ||
    typeof value.repoRoot !== 'string' ||
    typeof value.disabledAt !== 'string'
  ) {
    throw new Error(`Invalid Cursor disable marker: ${markerPath}`)
  }
  return value as CursorDisableMarker
}

export async function clearCursorDisableMarker(paths: ScopedPaths): Promise<void> {
  await rm(cursorLifecyclePaths(paths).disableMarkerPath, { force: true })
}

export async function cursorLifecycleArtifactsAreRegularFiles(
  filePaths: string[],
): Promise<boolean> {
  for (const filePath of filePaths) {
    try {
      if (!(await stat(filePath)).isFile()) {
        return false
      }
    } catch {
      return false
    }
  }
  return true
}
