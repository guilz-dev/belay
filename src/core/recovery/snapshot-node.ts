import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  open,
  readFile,
  readlink,
  rm,
  rmdir,
  symlink,
  writeFile,
} from 'node:fs/promises'
import path from 'node:path'

import { canonicalStringify, hashValue } from '../fingerprint.js'
import { canonicalPath } from '../path-utils.js'
import type { RecoveryCheckpointEntry, RecoveryFileSnapshotV2 } from './types.js'

export const RECOVERY_UNSUPPORTED_FILE_KIND = 'recovery_unsupported_file_kind'

export function validRecoveryRelativePath(relativePath: string): boolean {
  if (!relativePath || relativePath.includes('\0') || path.isAbsolute(relativePath)) return false
  const normalized = path.normalize(relativePath)
  return normalized !== '.' && normalized !== '..' && !normalized.startsWith(`..${path.sep}`)
}

export async function assertRecoverySafeTarget(
  resourceRoot: string,
  relativePath: string,
): Promise<string> {
  if (!validRecoveryRelativePath(relativePath)) throw new Error('recovery_path_escape')
  const root = canonicalPath(resourceRoot)
  const target = path.resolve(root, relativePath)
  const relative = path.relative(root, target)
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error('recovery_path_escape')
  }

  let current = root
  const parentParts = path.relative(root, path.dirname(target)).split(path.sep).filter(Boolean)
  for (const part of parentParts) {
    current = path.join(current, part)
    if (!existsSync(current)) break
    const info = await lstat(current)
    if (info.isSymbolicLink()) throw new Error('recovery_symlink_escape')
    if (!info.isDirectory()) break
  }
  return target
}

async function fsyncPath(filePath: string): Promise<void> {
  const handle = await open(filePath, 'r')
  try {
    await handle.sync()
  } finally {
    await handle.close()
  }
}

function normalizedMode(mode: number): number {
  return mode & 0o777
}

export function recoveryDirectoryHash(mode: number): string {
  return hashValue(`directory:${normalizedMode(mode)}`)
}

export function recoverySnapshotHash(snapshot: RecoveryFileSnapshotV2): string {
  return hashValue(canonicalStringify(snapshot))
}

export function withoutRecoveryBlob(snapshot: RecoveryFileSnapshotV2): RecoveryFileSnapshotV2 {
  if (snapshot.kind !== 'file') return { ...snapshot }
  const { blob: _blob, ...rest } = snapshot
  return rest
}

export async function captureRecoverySnapshot(
  filePath: string,
  options?: { blobDir?: string },
): Promise<RecoveryFileSnapshotV2> {
  let info: Awaited<ReturnType<typeof lstat>>
  try {
    info = await lstat(filePath)
  } catch (error) {
    if (!['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error
    return { kind: 'absent' }
  }
  if (info.isSymbolicLink()) {
    const symlinkTarget = await readlink(filePath)
    return {
      kind: 'symlink',
      symlinkTarget,
      hash: hashValue(`symlink:${symlinkTarget}`),
    }
  }
  if (info.isDirectory()) {
    const mode = normalizedMode(info.mode)
    return { kind: 'directory', mode, hash: recoveryDirectoryHash(mode) }
  }
  if (!info.isFile()) throw new Error(RECOVERY_UNSUPPORTED_FILE_KIND)

  const content = await readFile(filePath)
  const hash = createHash('sha256').update(content).digest('hex')
  let blob: string | undefined
  if (options?.blobDir) {
    await mkdir(options.blobDir, { recursive: true, mode: 0o700 })
    const blobPath = path.join(options.blobDir, hash)
    if (!existsSync(blobPath)) {
      await writeFile(blobPath, content, { mode: 0o600 })
      await fsyncPath(blobPath)
    }
    blob = `blobs/${hash}`
  }
  return { kind: 'file', mode: normalizedMode(info.mode), hash, ...(blob ? { blob } : {}) }
}

export async function recoverySnapshotMatches(
  filePath: string,
  expected: RecoveryFileSnapshotV2,
): Promise<boolean> {
  try {
    const current = await captureRecoverySnapshot(filePath)
    return (
      recoverySnapshotHash(withoutRecoveryBlob(current)) ===
      recoverySnapshotHash(withoutRecoveryBlob(expected))
    )
  } catch {
    return false
  }
}

export async function validateRecoverySnapshot(params: {
  snapshot: unknown
  side: 'before' | 'after'
  manifestVersion: 1 | 2
  artifactDir: string
  corruptReason: string
}): Promise<void> {
  const { snapshot } = params
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) {
    throw new Error(params.corruptReason)
  }
  const record = snapshot as Record<string, unknown>
  const hasExactKeys = (allowed: readonly string[]): boolean => {
    const keys = Object.keys(record)
    return keys.length === allowed.length && keys.every((key) => allowed.includes(key))
  }
  const validHash = (value: unknown): value is string =>
    typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
  const validMode = (value: unknown): value is number =>
    typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 0o777

  if (record.kind === 'absent') {
    if (!hasExactKeys(['kind'])) throw new Error(params.corruptReason)
    return
  }
  if (record.kind === 'directory') {
    if (
      params.manifestVersion !== 2 ||
      !hasExactKeys(['kind', 'mode', 'hash']) ||
      !validMode(record.mode) ||
      !validHash(record.hash) ||
      record.hash !== recoveryDirectoryHash(record.mode)
    ) {
      throw new Error(params.corruptReason)
    }
    return
  }
  if (record.kind === 'symlink') {
    if (
      !hasExactKeys(['kind', 'symlinkTarget', 'hash']) ||
      typeof record.symlinkTarget !== 'string' ||
      !validHash(record.hash) ||
      record.hash !== hashValue(`symlink:${record.symlinkTarget}`)
    ) {
      throw new Error(params.corruptReason)
    }
    return
  }
  if (record.kind !== 'file') throw new Error(params.corruptReason)
  const allowedKeys =
    record.blob === undefined ? ['kind', 'mode', 'hash'] : ['kind', 'mode', 'hash', 'blob']
  if (
    !hasExactKeys(allowedKeys) ||
    !validMode(record.mode) ||
    !validHash(record.hash) ||
    (record.blob !== undefined && typeof record.blob !== 'string')
  ) {
    throw new Error(params.corruptReason)
  }
  if (params.side === 'before' && !record.blob) throw new Error(params.corruptReason)
  if (!record.blob) return
  if (record.blob !== `blobs/${record.hash}`) throw new Error(params.corruptReason)
  let content: Buffer
  try {
    content = await readFile(path.join(params.artifactDir, record.blob))
  } catch {
    throw new Error(params.corruptReason)
  }
  if (createHash('sha256').update(content).digest('hex') !== record.hash) {
    throw new Error(params.corruptReason)
  }
}

async function removeTargetWithoutRecursion(target: string): Promise<void> {
  let info: Awaited<ReturnType<typeof lstat>>
  try {
    info = await lstat(target)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    throw error
  }
  if (info.isDirectory() && !info.isSymbolicLink()) {
    await rmdir(target)
    return
  }
  await rm(target, { force: true, recursive: false })
}

export async function applyRecoverySnapshot(
  target: string,
  snapshot: RecoveryFileSnapshotV2,
  artifactDir: string,
  corruptReason: string,
): Promise<void> {
  if (snapshot.kind === 'absent') {
    await removeTargetWithoutRecursion(target)
    return
  }

  let current: Awaited<ReturnType<typeof lstat>> | undefined
  try {
    current = await lstat(target)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }

  if (snapshot.kind === 'directory') {
    if (current && (!current.isDirectory() || current.isSymbolicLink())) {
      await removeTargetWithoutRecursion(target)
      current = undefined
    }
    if (!current) await mkdir(target, { recursive: false, mode: snapshot.mode })
    await chmod(target, snapshot.mode)
    return
  }

  if (current) await removeTargetWithoutRecursion(target)
  await mkdir(path.dirname(target), { recursive: true })
  if (snapshot.kind === 'symlink') {
    if (snapshot.symlinkTarget === undefined) throw new Error(corruptReason)
    await symlink(snapshot.symlinkTarget, target)
    return
  }
  if (!snapshot.blob || !snapshot.hash) throw new Error(corruptReason)
  const blobPath = path.join(artifactDir, snapshot.blob)
  let content: Buffer
  try {
    content = await readFile(blobPath)
  } catch {
    throw new Error(corruptReason)
  }
  if (createHash('sha256').update(content).digest('hex') !== snapshot.hash) {
    throw new Error(corruptReason)
  }
  await copyFile(blobPath, target)
  if (snapshot.mode !== undefined) await chmod(target, snapshot.mode)
}

interface RecoveryEntryLike {
  path: string
  before: RecoveryFileSnapshotV2
  after: RecoveryFileSnapshotV2
}

function pathDepth(relativePath: string): number {
  return relativePath.split(path.sep).length
}

export function sortRecoveryEntriesForSide<T extends RecoveryEntryLike>(
  entries: T[],
  side: 'before' | 'after',
): T[] {
  const rank = (entry: T): number => {
    if (entry[side].kind === 'absent') return 0
    if (entry[side].kind === 'directory') return 1
    return 2
  }
  return [...entries].sort((left, right) => {
    const rankDifference = rank(left) - rank(right)
    if (rankDifference !== 0) return rankDifference
    const depthDifference = pathDepth(left.path) - pathDepth(right.path)
    if (left[side].kind === 'absent' && depthDifference !== 0) return -depthDifference
    if (depthDifference !== 0) return depthDifference
    return left.path.localeCompare(right.path)
  })
}

export function recoveryStateHash(
  entries: RecoveryCheckpointEntry[],
  side: 'before' | 'after',
): string {
  return hashValue(
    canonicalStringify(entries.map((entry) => ({ path: entry.path, state: entry[side] }))),
  )
}
