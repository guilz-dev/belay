import { createHash } from 'node:crypto'
import { constants as fsConstants } from 'node:fs'
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  open,
  opendir,
  readlink,
  realpath,
  rm,
  symlink,
} from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { inspectGitResourceIdentity } from '../git-resource-identity.js'
import { canonicalPath } from '../path-utils.js'
import {
  computeTreeHash,
  FILE_CHECKPOINT_HARDLINK_UNSUPPORTED,
  FILE_CHECKPOINT_PREPARE_TIMEOUT,
  FILE_CHECKPOINT_QUOTA_EXCEEDED,
  FILE_CHECKPOINT_UNSUPPORTED_NODE,
  FileCheckpointDiagnosticError,
  type FileTreeEntry,
} from '../transactional/file-tree.js'
import { compareRelativePathsBytewise, joinRelativePath } from '../transactional/file-tree-path.js'
import {
  hashDirectoryNode,
  hashFileNode,
  hashSymlinkTarget,
  type PresentSnapshotNode,
} from '../transactional/snapshot-node.js'

export const CONTAINED_EXECUTION_CLEANUP_UNCONFIRMED = 'contained_execution_cleanup_unconfirmed'
export const CONTAINED_EXECUTION_SOURCE_CHANGED = 'contained_execution_source_changed'
export const CONTAINED_EXECUTION_UNSAFE_SYMLINK = 'contained_execution_unsafe_symlink'

export class ContainedExecutionCleanupUnconfirmedError extends Error {
  readonly code = CONTAINED_EXECUTION_CLEANUP_UNCONFIRMED

  constructor(
    readonly mirrorRoot: string,
    options?: ErrorOptions,
  ) {
    super(`${CONTAINED_EXECUTION_CLEANUP_UNCONFIRMED}: ${mirrorRoot}`, options)
    this.name = 'ContainedExecutionCleanupUnconfirmedError'
  }
}

export type ContainedExecutionMirrorBackend = 'file_copy'

export interface ContainedExecutionMirrorLimits {
  maxFiles: number
  maxSourceBytes: number
  maxWorkspaceBytes: number
  prepareTimeoutMs: number
}

export interface ContainedExecutionMirrorOptions {
  sourceRoot: string
  /** Must be supplied explicitly, even when the resolved set is deliberately empty. */
  controlPlaneRoots: string[]
  limits: ContainedExecutionMirrorLimits
}

export interface ContainedExecutionMirrorHandle {
  /** Exact private host root containing guest-visible content only. */
  hostMirrorRoot: string
  /** Absolute path at which Task 4 must mount hostMirrorRoot inside the guest. */
  guestWorkspacePath: string
  backend: ContainedExecutionMirrorBackend
  cleanup(): Promise<void>
}

interface MirrorTestDependencies {
  makeTempRoot?(): Promise<string>
  removeRoot?(root: string): Promise<void>
  now?(): number
  afterSnapshotCaptured?(): Promise<void>
  beforeCopyOpen?(sourcePath: string): Promise<void>
  afterCopyRead?(sourcePath: string, bytesRead: number, totalBytes: number): Promise<void>
}

interface MirrorDependencies {
  makeTempRoot(): Promise<string>
  removeRoot(root: string): Promise<void>
  now(): number
  afterSnapshotCaptured?(): Promise<void>
  beforeCopyOpen?(sourcePath: string): Promise<void>
  afterCopyRead?(sourcePath: string, bytesRead: number, totalBytes: number): Promise<void>
}

interface NodeIdentity {
  dev: bigint
  ino: bigint
  mode: bigint
  size: bigint
  mtimeNs: bigint
  ctimeNs: bigint
}

interface MirrorEntry extends FileTreeEntry {
  identity: NodeIdentity
}

interface MirrorSnapshot {
  entries: MirrorEntry[]
  treeHash: string
}

interface SnapshotContext {
  sourceRoot: string
  protectedRoots: string[]
  metadataRoots: Set<string>
  limits: ContainedExecutionMirrorLimits
  deadlineMs: number
  now(): number
  fileCount: number
  sourceBytes: number
}

interface CopyContext {
  limits: ContainedExecutionMirrorLimits
  deadlineMs: number
  now(): number
  sourceBytes: number
  workspaceBytes: number
  beforeCopyOpen?(sourcePath: string): Promise<void>
  afterCopyRead?(sourcePath: string, bytesRead: number, totalBytes: number): Promise<void>
}

const productionDependencies: MirrorDependencies = {
  makeTempRoot: () => mkdtemp(path.join(os.tmpdir(), 'belay-contained-mirror-')),
  removeRoot: (root) => rm(root, { recursive: true, force: true }),
  now: () => Date.now(),
}

function dependenciesForTests(overrides: MirrorTestDependencies): MirrorDependencies {
  return {
    makeTempRoot: overrides.makeTempRoot ?? productionDependencies.makeTempRoot,
    removeRoot: overrides.removeRoot ?? productionDependencies.removeRoot,
    now: overrides.now ?? productionDependencies.now,
    afterSnapshotCaptured: overrides.afterSnapshotCaptured,
    beforeCopyOpen: overrides.beforeCopyOpen,
    afterCopyRead: overrides.afterCopyRead,
  }
}

function isAtOrWithin(root: string, target: string): boolean {
  const relative = path.relative(root, target)
  return (
    relative === '' ||
    (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`))
  )
}

function isGitMetadataRelativePath(relativePath: string): boolean {
  return relativePath.split(path.sep).some((segment) => segment.toLowerCase() === '.git')
}

function identityFromStats(stats: {
  dev: bigint
  ino: bigint
  mode: bigint
  size: bigint
  mtimeNs: bigint
  ctimeNs: bigint
}): NodeIdentity {
  return {
    dev: stats.dev,
    ino: stats.ino,
    mode: stats.mode,
    size: stats.size,
    mtimeNs: stats.mtimeNs,
    ctimeNs: stats.ctimeNs,
  }
}

function identitiesEqual(left: NodeIdentity, right: NodeIdentity): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  )
}

function safePermissionMode(mode: bigint | number): number {
  return Number(mode) & 0o777
}

function assertDeadline(deadlineMs: number, now: () => number): void {
  if (now() > deadlineMs) {
    throw new FileCheckpointDiagnosticError(
      FILE_CHECKPOINT_PREPARE_TIMEOUT,
      `mirror preparation exceeded deadlineMs=${deadlineMs}`,
    )
  }
}

function throwQuota(detail: string): never {
  throw new FileCheckpointDiagnosticError(FILE_CHECKPOINT_QUOTA_EXCEEDED, detail)
}

function addSnapshotNode(context: SnapshotContext): void {
  context.fileCount += 1
  if (context.fileCount > context.limits.maxFiles) {
    throwQuota(`mirror nodeCount=${context.fileCount} exceeds maxFiles=${context.limits.maxFiles}`)
  }
}

function addSourceBytes(
  context: Pick<SnapshotContext | CopyContext, 'sourceBytes' | 'limits'>,
  bytes: number,
): void {
  context.sourceBytes += bytes
  if (context.sourceBytes > context.limits.maxSourceBytes) {
    throwQuota(
      `mirror sourceBytes=${context.sourceBytes} exceeds maxSourceBytes=${context.limits.maxSourceBytes}`,
    )
  }
}

function addWorkspaceBytes(context: CopyContext, bytes: number): void {
  context.workspaceBytes += bytes
  if (context.workspaceBytes > context.limits.maxWorkspaceBytes) {
    throwQuota(
      `mirror workspaceBytes=${context.workspaceBytes} exceeds maxWorkspaceBytes=${context.limits.maxWorkspaceBytes}`,
    )
  }
}

function safeReadFlags(): number {
  if (fsConstants.O_NOFOLLOW === undefined || fsConstants.O_NONBLOCK === undefined) {
    throw new Error('contained_execution_safe_open_unavailable')
  }
  return fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK
}

function assertRegularSingleLink(stats: Awaited<ReturnType<typeof lstat>>): void {
  if (!stats.isFile()) {
    throw new Error(FILE_CHECKPOINT_UNSUPPORTED_NODE)
  }
  if (stats.nlink > 1) {
    throw new Error(FILE_CHECKPOINT_HARDLINK_UNSUPPORTED)
  }
}

function assertRegularSingleLinkBigInt(
  stats: Awaited<ReturnType<Awaited<ReturnType<typeof open>>['stat']>>,
): void {
  if (!stats.isFile()) {
    throw new Error(FILE_CHECKPOINT_UNSUPPORTED_NODE)
  }
  if (stats.nlink > 1n) {
    throw new Error(FILE_CHECKPOINT_HARDLINK_UNSUPPORTED)
  }
}

async function readStableFile(
  absolutePath: string,
  context: SnapshotContext,
): Promise<{ node: PresentSnapshotNode & { kind: 'file' }; identity: NodeIdentity }> {
  assertDeadline(context.deadlineMs, context.now)
  const before = await lstat(absolutePath, { bigint: true })
  if (!before.isFile()) {
    throw new Error(FILE_CHECKPOINT_UNSUPPORTED_NODE)
  }
  if (before.nlink > 1n) {
    throw new Error(FILE_CHECKPOINT_HARDLINK_UNSUPPORTED)
  }

  const source = await open(absolutePath, safeReadFlags())
  try {
    const opened = await source.stat({ bigint: true })
    assertRegularSingleLinkBigInt(opened)
    const openedIdentity = identityFromStats(opened)
    if (!identitiesEqual(identityFromStats(before), openedIdentity)) {
      throw new Error(CONTAINED_EXECUTION_SOURCE_CHANGED)
    }

    const hash = createHash('sha256')
    const buffer = Buffer.allocUnsafe(64 * 1024)
    let position = 0
    while (true) {
      assertDeadline(context.deadlineMs, context.now)
      const { bytesRead } = await source.read(buffer, 0, buffer.length, position)
      if (bytesRead === 0) {
        break
      }
      addSourceBytes(context, bytesRead)
      hash.update(buffer.subarray(0, bytesRead))
      position += bytesRead
    }

    const after = await source.stat({ bigint: true })
    assertRegularSingleLinkBigInt(after)
    if (
      !identitiesEqual(openedIdentity, identityFromStats(after)) ||
      BigInt(position) !== after.size
    ) {
      throw new Error(CONTAINED_EXECUTION_SOURCE_CHANGED)
    }
    const mode = Number(after.mode)
    return {
      node: {
        kind: 'file',
        mode,
        size: position,
        hash: hashFileNode(mode, hash.digest('hex')),
      },
      identity: openedIdentity,
    }
  } finally {
    await source.close()
  }
}

function addMetadataRoots(context: SnapshotContext, directoryPath: string): void {
  const inspection = inspectGitResourceIdentity(directoryPath)
  if (inspection.status === 'invalid') {
    for (const root of inspection.metadataRoots) {
      context.metadataRoots.add(canonicalPath(root))
    }
    return
  }
  if (
    inspection.status === 'resolved' &&
    canonicalPath(inspection.identity.repositoryRoot) === canonicalPath(directoryPath)
  ) {
    context.metadataRoots.add(canonicalPath(inspection.identity.gitEntryPath))
    context.metadataRoots.add(canonicalPath(inspection.identity.gitDir))
    context.metadataRoots.add(canonicalPath(inspection.identity.commonDir))
  }
}

function pathMatchesRoots(absolutePath: string, roots: Iterable<string>): boolean {
  const lexical = path.resolve(absolutePath)
  const canonical = canonicalPath(absolutePath)
  for (const root of roots) {
    if (isAtOrWithin(root, lexical) || isAtOrWithin(root, canonical)) {
      return true
    }
  }
  return false
}

function pathLexicallyMatchesRoots(absolutePath: string, roots: Iterable<string>): boolean {
  const lexical = path.resolve(absolutePath)
  for (const root of roots) {
    if (isAtOrWithin(root, lexical)) {
      return true
    }
  }
  return false
}

function isLexicallyExcludedLocation(
  absolutePath: string,
  relativePath: string,
  context: SnapshotContext,
): boolean {
  return (
    isGitMetadataRelativePath(relativePath) ||
    pathLexicallyMatchesRoots(absolutePath, context.protectedRoots) ||
    pathLexicallyMatchesRoots(absolutePath, context.metadataRoots)
  )
}

function isExcludedLocation(
  absolutePath: string,
  relativePath: string,
  context: SnapshotContext,
): boolean {
  return (
    isGitMetadataRelativePath(relativePath) ||
    pathMatchesRoots(absolutePath, context.protectedRoots) ||
    pathMatchesRoots(absolutePath, context.metadataRoots)
  )
}

async function readSafeSymlink(
  absolutePath: string,
  context: SnapshotContext,
): Promise<{ node: PresentSnapshotNode & { kind: 'symlink' }; identity: NodeIdentity }> {
  const before = await lstat(absolutePath, { bigint: true })
  if (!before.isSymbolicLink()) {
    throw new Error(CONTAINED_EXECUTION_SOURCE_CHANGED)
  }
  const identity = identityFromStats(before)
  const target = await readlink(absolutePath)
  if (path.isAbsolute(target)) {
    throw new Error(CONTAINED_EXECUTION_UNSAFE_SYMLINK)
  }

  const lexicalTarget = path.resolve(path.dirname(absolutePath), target)
  if (
    !isAtOrWithin(context.sourceRoot, lexicalTarget) ||
    isGitMetadataRelativePath(path.relative(context.sourceRoot, lexicalTarget)) ||
    pathMatchesRoots(lexicalTarget, context.protectedRoots) ||
    pathMatchesRoots(lexicalTarget, context.metadataRoots)
  ) {
    throw new Error(CONTAINED_EXECUTION_UNSAFE_SYMLINK)
  }

  let resolvedTarget: string
  try {
    resolvedTarget = await realpath(absolutePath)
  } catch {
    throw new Error(CONTAINED_EXECUTION_UNSAFE_SYMLINK)
  }
  if (
    !isAtOrWithin(context.sourceRoot, resolvedTarget) ||
    pathMatchesRoots(resolvedTarget, context.protectedRoots) ||
    pathMatchesRoots(resolvedTarget, context.metadataRoots)
  ) {
    throw new Error(CONTAINED_EXECUTION_UNSAFE_SYMLINK)
  }

  const after = await lstat(absolutePath, { bigint: true })
  const targetAfter = await readlink(absolutePath)
  if (
    !after.isSymbolicLink() ||
    !identitiesEqual(identity, identityFromStats(after)) ||
    targetAfter !== target
  ) {
    throw new Error(CONTAINED_EXECUTION_SOURCE_CHANGED)
  }

  return {
    node: { kind: 'symlink', target, hash: hashSymlinkTarget(target) },
    identity,
  }
}

async function walkDirectory(
  relativeDirectory: string,
  entries: MirrorEntry[],
  context: SnapshotContext,
): Promise<void> {
  assertDeadline(context.deadlineMs, context.now)
  const absoluteDirectory = relativeDirectory
    ? joinRelativePath(context.sourceRoot, relativeDirectory)
    : context.sourceRoot
  addMetadataRoots(context, absoluteDirectory)

  const before = await lstat(absoluteDirectory, { bigint: true })
  if (!before.isDirectory() || before.isSymbolicLink()) {
    throw new Error(CONTAINED_EXECUTION_SOURCE_CHANGED)
  }
  const beforeIdentity = identityFromStats(before)
  const resolvedDirectory = await realpath(absoluteDirectory)
  if (!isAtOrWithin(context.sourceRoot, resolvedDirectory)) {
    throw new Error(CONTAINED_EXECUTION_SOURCE_CHANGED)
  }

  const directoryFlags = safeReadFlags() | (fsConstants.O_DIRECTORY ?? 0)
  const directory = await open(absoluteDirectory, directoryFlags)
  try {
    const opened = await directory.stat({ bigint: true })
    if (!opened.isDirectory() || !identitiesEqual(beforeIdentity, identityFromStats(opened))) {
      throw new Error(CONTAINED_EXECUTION_SOURCE_CHANGED)
    }

    const entriesDirectory = await opendir(absoluteDirectory, { bufferSize: 32 })
    for await (const directoryEntry of entriesDirectory) {
      assertDeadline(context.deadlineMs, context.now)
      const relativePath = relativeDirectory
        ? path.join(relativeDirectory, directoryEntry.name)
        : directoryEntry.name
      const absolutePath = joinRelativePath(context.sourceRoot, relativePath)
      const info = await lstat(absolutePath)
      if (info.isSymbolicLink()) {
        if (isLexicallyExcludedLocation(absolutePath, relativePath, context)) {
          continue
        }
        addSnapshotNode(context)
        const captured = await readSafeSymlink(absolutePath, context)
        entries.push({ relativePath, ...captured })
        continue
      }
      if (isExcludedLocation(absolutePath, relativePath, context)) {
        continue
      }
      if (info.isDirectory()) {
        addSnapshotNode(context)
        const node: PresentSnapshotNode = {
          kind: 'directory',
          mode: info.mode,
          hash: hashDirectoryNode(info.mode),
        }
        entries.push({
          relativePath,
          node,
          identity: identityFromStats(await lstat(absolutePath, { bigint: true })),
        })
        await walkDirectory(relativePath, entries, context)
        continue
      }
      if (info.isFile()) {
        assertRegularSingleLink(info)
        addSnapshotNode(context)
        const captured = await readStableFile(absolutePath, context)
        entries.push({ relativePath, ...captured })
        continue
      }
      throw new Error(FILE_CHECKPOINT_UNSUPPORTED_NODE)
    }

    const after = await directory.stat({ bigint: true })
    const pathAfter = await lstat(absoluteDirectory, { bigint: true })
    if (
      !identitiesEqual(beforeIdentity, identityFromStats(after)) ||
      !identitiesEqual(beforeIdentity, identityFromStats(pathAfter))
    ) {
      throw new Error(CONTAINED_EXECUTION_SOURCE_CHANGED)
    }
  } finally {
    await directory.close()
  }
}

async function buildSafeMirrorSnapshot(
  sourceRoot: string,
  protectedRoots: string[],
  limits: ContainedExecutionMirrorLimits,
  deadlineMs: number,
  now: () => number,
): Promise<MirrorSnapshot> {
  const canonicalSourceRoot = await realpath(sourceRoot)
  const rootInfo = await lstat(canonicalSourceRoot)
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) {
    throw new Error('contained_execution_source_not_directory')
  }

  const context: SnapshotContext = {
    sourceRoot: canonicalSourceRoot,
    protectedRoots,
    metadataRoots: new Set<string>(),
    limits,
    deadlineMs,
    now,
    fileCount: 0,
    sourceBytes: 0,
  }
  const entries: MirrorEntry[] = []
  await walkDirectory('', entries, context)
  entries.sort((left, right) => compareRelativePathsBytewise(left.relativePath, right.relativePath))
  return { entries, treeHash: computeTreeHash(entries) }
}

function assertEntryIdentity(entry: MirrorEntry, identity: NodeIdentity): void {
  if (!identitiesEqual(entry.identity, identity)) {
    throw new Error(CONTAINED_EXECUTION_SOURCE_CHANGED)
  }
}

async function copyStableRegularFile(
  sourcePath: string,
  destinationPath: string,
  entry: MirrorEntry,
  context: CopyContext,
): Promise<void> {
  const before = await lstat(sourcePath, { bigint: true })
  if (!before.isFile()) {
    throw new Error(FILE_CHECKPOINT_UNSUPPORTED_NODE)
  }
  if (before.nlink > 1n) {
    throw new Error(FILE_CHECKPOINT_HARDLINK_UNSUPPORTED)
  }
  assertEntryIdentity(entry, identityFromStats(before))

  await context.beforeCopyOpen?.(sourcePath)
  const source = await open(sourcePath, safeReadFlags())
  let destination: Awaited<ReturnType<typeof open>> | undefined
  try {
    const opened = await source.stat({ bigint: true })
    assertRegularSingleLinkBigInt(opened)
    const openedIdentity = identityFromStats(opened)
    assertEntryIdentity(entry, openedIdentity)
    if (entry.node.kind !== 'file') {
      throw new Error(CONTAINED_EXECUTION_SOURCE_CHANGED)
    }

    await mkdir(path.dirname(destinationPath), { recursive: true, mode: 0o700 })
    destination = await open(
      destinationPath,
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL,
      safePermissionMode(opened.mode),
    )
    const hash = createHash('sha256')
    const buffer = Buffer.allocUnsafe(64 * 1024)
    let position = 0
    while (true) {
      assertDeadline(context.deadlineMs, context.now)
      const { bytesRead } = await source.read(buffer, 0, buffer.length, position)
      if (bytesRead === 0) {
        break
      }
      addSourceBytes(context, bytesRead)
      addWorkspaceBytes(context, bytesRead)
      hash.update(buffer.subarray(0, bytesRead))
      let written = 0
      while (written < bytesRead) {
        const result = await destination.write(
          buffer,
          written,
          bytesRead - written,
          position + written,
        )
        written += result.bytesWritten
      }
      position += bytesRead
      await context.afterCopyRead?.(sourcePath, bytesRead, position)
    }
    const after = await source.stat({ bigint: true })
    assertRegularSingleLinkBigInt(after)
    if (
      !identitiesEqual(openedIdentity, identityFromStats(after)) ||
      BigInt(position) !== after.size ||
      hashFileNode(Number(after.mode), hash.digest('hex')) !== entry.node.hash
    ) {
      throw new Error(CONTAINED_EXECUTION_SOURCE_CHANGED)
    }
    await destination.sync()
  } finally {
    await Promise.allSettled([source.close(), destination?.close() ?? Promise.resolve()])
  }
  if (entry.node.kind !== 'file') {
    throw new Error(CONTAINED_EXECUTION_SOURCE_CHANGED)
  }
  await chmod(destinationPath, safePermissionMode(entry.node.mode))
}

async function materializeSnapshot(
  sourceRoot: string,
  destinationRoot: string,
  snapshot: MirrorSnapshot,
  context: CopyContext,
): Promise<void> {
  const directoryEntries: MirrorEntry[] = []
  for (const entry of snapshot.entries) {
    assertDeadline(context.deadlineMs, context.now)
    const sourcePath = joinRelativePath(sourceRoot, entry.relativePath)
    const destinationPath = joinRelativePath(destinationRoot, entry.relativePath)
    if (entry.node.kind === 'directory') {
      await mkdir(destinationPath, { recursive: true, mode: 0o700 })
      directoryEntries.push(entry)
      continue
    }
    if (entry.node.kind === 'symlink') {
      addWorkspaceBytes(context, Buffer.byteLength(entry.node.target))
      const current = await readlink(sourcePath)
      const currentInfo = await lstat(sourcePath, { bigint: true })
      assertEntryIdentity(entry, identityFromStats(currentInfo))
      if (current !== entry.node.target) {
        throw new Error(CONTAINED_EXECUTION_SOURCE_CHANGED)
      }
      await mkdir(path.dirname(destinationPath), { recursive: true, mode: 0o700 })
      await symlink(entry.node.target, destinationPath)
      continue
    }
    await copyStableRegularFile(sourcePath, destinationPath, entry, context)
  }

  for (const entry of directoryEntries.reverse()) {
    if (entry.node.kind !== 'directory') {
      throw new Error(CONTAINED_EXECUTION_SOURCE_CHANGED)
    }
    await chmod(
      joinRelativePath(destinationRoot, entry.relativePath),
      safePermissionMode(entry.node.mode),
    )
  }
  await chmod(destinationRoot, 0o700)
}

async function assertStableCopiedSnapshot(
  sourceRoot: string,
  destinationRoot: string,
  protectedRoots: string[],
  limits: ContainedExecutionMirrorLimits,
  deadlineMs: number,
  now: () => number,
  before: MirrorSnapshot,
): Promise<void> {
  const [after, copied] = await Promise.all([
    buildSafeMirrorSnapshot(sourceRoot, protectedRoots, limits, deadlineMs, now),
    buildSafeMirrorSnapshot(destinationRoot, [], limits, deadlineMs, now),
  ])
  if (before.treeHash !== after.treeHash || before.treeHash !== copied.treeHash) {
    throw new Error(CONTAINED_EXECUTION_SOURCE_CHANGED)
  }
}

function validateOptions(options: ContainedExecutionMirrorOptions): void {
  if (!Array.isArray(options.controlPlaneRoots)) {
    throw new Error('contained_execution_control_plane_roots_required')
  }
  const values = [
    options.limits?.maxFiles,
    options.limits?.maxSourceBytes,
    options.limits?.maxWorkspaceBytes,
    options.limits?.prepareTimeoutMs,
  ]
  if (values.some((value) => !Number.isSafeInteger(value) || (value ?? 0) <= 0)) {
    throw new Error('contained_execution_mirror_limits_invalid')
  }
}

async function pathIsAbsent(targetPath: string): Promise<boolean> {
  try {
    await lstat(targetPath)
    return false
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT'
  }
}

async function cleanupOwnedRoot(root: string, dependencies: MirrorDependencies): Promise<void> {
  try {
    await dependencies.removeRoot(root)
  } catch (error) {
    throw new ContainedExecutionCleanupUnconfirmedError(root, { cause: error })
  }
  if (!(await pathIsAbsent(root))) {
    throw new ContainedExecutionCleanupUnconfirmedError(root)
  }
}

async function prepareWithDependencies(
  options: ContainedExecutionMirrorOptions,
  dependencies: MirrorDependencies,
): Promise<ContainedExecutionMirrorHandle> {
  validateOptions(options)
  const guestWorkspacePath = path.resolve(options.sourceRoot)
  const sourceRoot = canonicalPath(options.sourceRoot)
  const protectedRoots = options.controlPlaneRoots.map((root) => canonicalPath(root))
  if (pathMatchesRoots(sourceRoot, protectedRoots)) {
    throw new Error('contained_execution_source_is_protected')
  }

  const guestRoot = await dependencies.makeTempRoot()
  try {
    await chmod(guestRoot, 0o700)
    const deadlineMs = dependencies.now() + options.limits.prepareTimeoutMs
    const before = await buildSafeMirrorSnapshot(
      sourceRoot,
      protectedRoots,
      options.limits,
      deadlineMs,
      dependencies.now,
    )
    await dependencies.afterSnapshotCaptured?.()
    await materializeSnapshot(sourceRoot, guestRoot, before, {
      limits: options.limits,
      deadlineMs,
      now: dependencies.now,
      sourceBytes: 0,
      workspaceBytes: 0,
      beforeCopyOpen: dependencies.beforeCopyOpen,
      afterCopyRead: dependencies.afterCopyRead,
    })
    await assertStableCopiedSnapshot(
      sourceRoot,
      guestRoot,
      protectedRoots,
      options.limits,
      deadlineMs,
      dependencies.now,
      before,
    )
    await chmod(guestRoot, 0o700)

    return {
      hostMirrorRoot: guestRoot,
      guestWorkspacePath,
      backend: 'file_copy',
      cleanup: () => cleanupOwnedRoot(guestRoot, dependencies),
    }
  } catch (error) {
    try {
      await cleanupOwnedRoot(guestRoot, dependencies)
    } catch (cleanupError) {
      throw new ContainedExecutionCleanupUnconfirmedError(guestRoot, { cause: cleanupError })
    }
    throw error
  }
}

/**
 * Non-atomic acceptance rule: the current source tree is read, copied, then read again. A mirror
 * is returned only when both source observations and the copied tree have the same content/mode
 * hash. This detects ordinary concurrent changes but does not claim an atomic filesystem snapshot.
 */
export function prepareContainedExecutionMirror(
  options: ContainedExecutionMirrorOptions,
): Promise<ContainedExecutionMirrorHandle> {
  return prepareWithDependencies(options, productionDependencies)
}

/** Narrow test seam for deterministic allocation, race, deadline, and removal failures. */
export function prepareContainedExecutionMirrorForTests(
  options: ContainedExecutionMirrorOptions,
  overrides: MirrorTestDependencies,
): Promise<ContainedExecutionMirrorHandle> {
  return prepareWithDependencies(options, dependenciesForTests(overrides))
}

async function withMirror<T>(
  options: ContainedExecutionMirrorOptions,
  operation: (mirror: ContainedExecutionMirrorHandle) => Promise<T>,
  dependencies: MirrorDependencies,
): Promise<T> {
  const mirror = await prepareWithDependencies(options, dependencies)
  try {
    return await operation(mirror)
  } finally {
    await mirror.cleanup()
  }
}

export function withContainedExecutionMirror<T>(
  options: ContainedExecutionMirrorOptions,
  operation: (mirror: ContainedExecutionMirrorHandle) => Promise<T>,
): Promise<T> {
  return withMirror(options, operation, productionDependencies)
}

/** Narrow test seam matching prepareContainedExecutionMirrorForTests. */
export function withContainedExecutionMirrorForTests<T>(
  options: ContainedExecutionMirrorOptions,
  operation: (mirror: ContainedExecutionMirrorHandle) => Promise<T>,
  overrides: MirrorTestDependencies,
): Promise<T> {
  return withMirror(options, operation, dependenciesForTests(overrides))
}
