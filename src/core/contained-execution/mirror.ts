import { constants as fsConstants } from 'node:fs'
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readdir,
  realpath,
  rm,
  symlink,
} from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { inspectGitResourceIdentity } from '../git-resource-identity.js'
import { canonicalPath } from '../path-utils.js'
import { execGit } from '../transactional/file-checkpoint-git.js'
import { computeTreeHash, type FileTreeEntry } from '../transactional/file-tree.js'
import { compareRelativePathsBytewise, joinRelativePath } from '../transactional/file-tree-path.js'
import { isDirtyWorktree } from '../transactional/git-worktree.js'
import { readSnapshotNode } from '../transactional/snapshot-node.js'

export const CONTAINED_EXECUTION_CLEANUP_UNCONFIRMED = 'contained_execution_cleanup_unconfirmed'
export const CONTAINED_EXECUTION_SOURCE_CHANGED = 'contained_execution_source_changed'

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

export type ContainedExecutionMirrorBackend = 'clean_git_worktree' | 'file_copy'

export interface ContainedExecutionMirrorOptions {
  sourceRoot: string
  controlPlaneRoots?: string[]
}

export interface ContainedExecutionMirrorHandle {
  /** Host path containing disposable guest-visible content only. */
  hostMirrorRoot: string
  /** Absolute path at which Task 4 must mount hostMirrorRoot inside the guest. */
  guestWorkspacePath: string
  backend: ContainedExecutionMirrorBackend
  cleanup(): Promise<void>
}

interface MirrorTestDependencies {
  makeTempRoot?(): Promise<string>
  removeRoot?(root: string): Promise<void>
}

interface MirrorDependencies {
  makeTempRoot(): Promise<string>
  removeRoot(root: string): Promise<void>
}

interface MirrorSnapshot {
  entries: FileTreeEntry[]
  treeHash: string
  rootMode: number
}

interface RegisteredWorktree {
  sourceRoot: string
  worktreeRoot: string
}

interface CleanupState {
  guestRoot: string
  registeredWorktree?: RegisteredWorktree
}

const productionDependencies: MirrorDependencies = {
  makeTempRoot: () => mkdtemp(path.join(os.tmpdir(), 'belay-contained-mirror-')),
  removeRoot: (root) => rm(root, { recursive: true, force: true }),
}

function dependenciesForTests(overrides: MirrorTestDependencies): MirrorDependencies {
  return {
    makeTempRoot: overrides.makeTempRoot ?? productionDependencies.makeTempRoot,
    removeRoot: overrides.removeRoot ?? productionDependencies.removeRoot,
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
  return relativePath.split(path.sep).includes('.git')
}

function isProtectedPath(absolutePath: string, protectedRoots: string[]): boolean {
  const candidate = canonicalPath(absolutePath)
  return protectedRoots.some((root) => isAtOrWithin(root, candidate))
}

async function safeSymlinkNode(
  sourceRoot: string,
  absolutePath: string,
  protectedRoots: string[],
): Promise<FileTreeEntry['node'] | null> {
  const node = await readSnapshotNode(absolutePath)
  if (node.kind !== 'symlink' || path.isAbsolute(node.target)) {
    return null
  }

  let resolvedTarget: string
  try {
    resolvedTarget = await realpath(absolutePath)
  } catch {
    return null
  }
  if (
    !isAtOrWithin(sourceRoot, resolvedTarget) ||
    isProtectedPath(resolvedTarget, protectedRoots)
  ) {
    return null
  }
  return node
}

async function buildSafeMirrorSnapshot(
  sourceRoot: string,
  protectedRoots: string[],
): Promise<MirrorSnapshot> {
  const canonicalSourceRoot = await realpath(sourceRoot)
  const rootInfo = await lstat(sourceRoot)
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) {
    throw new Error('contained_execution_source_not_directory')
  }

  const entries: FileTreeEntry[] = []
  async function walk(relativeDirectory: string): Promise<void> {
    const absoluteDirectory = relativeDirectory
      ? joinRelativePath(sourceRoot, relativeDirectory)
      : sourceRoot
    const resolvedDirectory = await realpath(absoluteDirectory)
    const directoryInfo = await lstat(absoluteDirectory)
    if (
      !isAtOrWithin(canonicalSourceRoot, resolvedDirectory) ||
      !directoryInfo.isDirectory() ||
      directoryInfo.isSymbolicLink()
    ) {
      throw new Error(CONTAINED_EXECUTION_SOURCE_CHANGED)
    }
    const names = await readdir(absoluteDirectory)
    for (const name of names) {
      const relativePath = relativeDirectory ? path.join(relativeDirectory, name) : name
      if (isGitMetadataRelativePath(relativePath)) {
        continue
      }
      const absolutePath = joinRelativePath(sourceRoot, relativePath)
      if (isProtectedPath(absolutePath, protectedRoots)) {
        continue
      }

      const info = await lstat(absolutePath)
      if (info.isSymbolicLink()) {
        const node = await safeSymlinkNode(canonicalSourceRoot, absolutePath, protectedRoots)
        if (node) {
          entries.push({ relativePath, node })
        }
        continue
      }
      if (info.isDirectory()) {
        const node = await readSnapshotNode(absolutePath)
        if (node.kind !== 'directory') {
          throw new Error(CONTAINED_EXECUTION_SOURCE_CHANGED)
        }
        entries.push({ relativePath, node })
        await walk(relativePath)
        continue
      }
      if (info.isFile()) {
        const node = await readSnapshotNode(absolutePath)
        if (node.kind !== 'file') {
          throw new Error(CONTAINED_EXECUTION_SOURCE_CHANGED)
        }
        entries.push({ relativePath, node })
      }
      // Sockets, FIFOs, devices, and other unsupported nodes are deliberately omitted.
    }
  }

  await walk('')
  entries.sort((left, right) => compareRelativePathsBytewise(left.relativePath, right.relativePath))
  return {
    entries,
    treeHash: computeTreeHash(entries),
    rootMode: rootInfo.mode & 0o777,
  }
}

async function copyRegularFileWithoutFollowingLinks(
  sourcePath: string,
  destinationPath: string,
  mode: number,
): Promise<void> {
  await mkdir(path.dirname(destinationPath), { recursive: true })
  const noFollow = fsConstants.O_NOFOLLOW ?? 0
  const source = await open(sourcePath, fsConstants.O_RDONLY | noFollow)
  let destination: Awaited<ReturnType<typeof open>> | undefined
  try {
    const sourceInfo = await source.stat()
    if (!sourceInfo.isFile()) {
      throw new Error(CONTAINED_EXECUTION_SOURCE_CHANGED)
    }
    destination = await open(
      destinationPath,
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL,
      mode & 0o777,
    )
    const buffer = Buffer.allocUnsafe(64 * 1024)
    let position = 0
    while (true) {
      const { bytesRead } = await source.read(buffer, 0, buffer.length, position)
      if (bytesRead === 0) {
        break
      }
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
    }
    await destination.sync()
  } finally {
    await Promise.allSettled([source.close(), destination?.close() ?? Promise.resolve()])
  }
  await chmod(destinationPath, mode & 0o777)
}

async function materializeSnapshot(
  sourceRoot: string,
  destinationRoot: string,
  snapshot: MirrorSnapshot,
): Promise<void> {
  const directoryEntries: FileTreeEntry[] = []
  for (const entry of snapshot.entries) {
    const sourcePath = joinRelativePath(sourceRoot, entry.relativePath)
    const destinationPath = joinRelativePath(destinationRoot, entry.relativePath)
    if (entry.node.kind === 'directory') {
      await mkdir(destinationPath, { recursive: true, mode: 0o700 })
      directoryEntries.push(entry)
      continue
    }
    if (entry.node.kind === 'symlink') {
      await mkdir(path.dirname(destinationPath), { recursive: true })
      await symlink(entry.node.target, destinationPath)
      continue
    }
    if (entry.node.kind === 'file') {
      await copyRegularFileWithoutFollowingLinks(sourcePath, destinationPath, entry.node.mode)
    }
  }

  for (const entry of directoryEntries.reverse()) {
    if (entry.node.kind !== 'directory') {
      throw new Error(CONTAINED_EXECUTION_SOURCE_CHANGED)
    }
    await chmod(joinRelativePath(destinationRoot, entry.relativePath), entry.node.mode & 0o777)
  }
  await chmod(destinationRoot, snapshot.rootMode)
}

async function assertStableCopiedSnapshot(
  sourceRoot: string,
  destinationRoot: string,
  protectedRoots: string[],
  before: MirrorSnapshot,
): Promise<void> {
  const [after, copied] = await Promise.all([
    buildSafeMirrorSnapshot(sourceRoot, protectedRoots),
    buildSafeMirrorSnapshot(destinationRoot, []),
  ])
  if (
    before.treeHash !== after.treeHash ||
    before.rootMode !== after.rootMode ||
    before.treeHash !== copied.treeHash ||
    before.rootMode !== copied.rootMode
  ) {
    const copiedNodes = new Map(
      copied.entries.map((entry) => [entry.relativePath, entry.node.hash]),
    )
    const mismatch = before.entries.find(
      (entry) => copiedNodes.get(entry.relativePath) !== entry.node.hash,
    )
    const extra = copied.entries.find(
      (entry) =>
        !before.entries.some((beforeEntry) => beforeEntry.relativePath === entry.relativePath),
    )
    throw new Error(
      `${CONTAINED_EXECUTION_SOURCE_CHANGED}: before=${before.treeHash}/${before.rootMode.toString(
        8,
      )} after=${after.treeHash}/${after.rootMode.toString(8)} copied=${copied.treeHash}/${copied.rootMode.toString(8)} mismatch=${mismatch?.relativePath ?? extra?.relativePath ?? 'root'} expected=${mismatch?.node.hash ?? '-'} actual=${mismatch ? (copiedNodes.get(mismatch.relativePath) ?? 'absent') : '-'}`,
    )
  }
}

async function copyStableTree(
  sourceRoot: string,
  destinationRoot: string,
  protectedRoots: string[],
): Promise<void> {
  const before = await buildSafeMirrorSnapshot(sourceRoot, protectedRoots)
  await materializeSnapshot(sourceRoot, destinationRoot, before)
  await assertStableCopiedSnapshot(sourceRoot, destinationRoot, protectedRoots, before)
}

function protectedRootsWithinSource(sourceRoot: string, roots: string[]): string[] {
  return roots.map((root) => canonicalPath(root)).filter((root) => isAtOrWithin(sourceRoot, root))
}

function mapProtectedRoots(
  sourceRoot: string,
  destinationRoot: string,
  protectedRoots: string[],
): string[] {
  return protectedRoots.map((root) => path.join(destinationRoot, path.relative(sourceRoot, root)))
}

async function pathIsAbsent(targetPath: string): Promise<boolean> {
  try {
    await lstat(targetPath)
    return false
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT'
  }
}

function listedWorktreePaths(output: string): string[] {
  return output
    .split('\n')
    .filter((line) => line.startsWith('worktree '))
    .map((line) => path.resolve(line.slice('worktree '.length)))
}

async function removeRegisteredWorktree(
  registration: RegisteredWorktree,
  dependencies: MirrorDependencies,
): Promise<boolean> {
  try {
    await execGit(registration.sourceRoot, [
      'worktree',
      'remove',
      '--force',
      registration.worktreeRoot,
    ])
  } catch {
    try {
      await dependencies.removeRoot(registration.worktreeRoot)
      await execGit(registration.sourceRoot, ['worktree', 'prune', '--expire', 'now'])
    } catch {
      return false
    }
  }

  if (!(await pathIsAbsent(registration.worktreeRoot))) {
    return false
  }
  try {
    const listed = listedWorktreePaths(
      await execGit(registration.sourceRoot, ['worktree', 'list', '--porcelain']),
    )
    return !listed.includes(path.resolve(registration.worktreeRoot))
  } catch {
    return false
  }
}

async function cleanupMirrorState(
  state: CleanupState,
  dependencies: MirrorDependencies,
): Promise<void> {
  let guestRemoved = false
  try {
    await dependencies.removeRoot(state.guestRoot)
    guestRemoved = await pathIsAbsent(state.guestRoot)
  } catch {
    guestRemoved = false
  }

  const worktreeRemoved = state.registeredWorktree
    ? await removeRegisteredWorktree(state.registeredWorktree, dependencies)
    : true
  if (!guestRemoved || !worktreeRemoved) {
    throw new ContainedExecutionCleanupUnconfirmedError(state.guestRoot)
  }
}

async function prepareFileCopy(
  sourceRoot: string,
  guestRoot: string,
  protectedRoots: string[],
): Promise<void> {
  await copyStableTree(sourceRoot, guestRoot, protectedRoots)
}

async function prepareCleanGitCopy(
  sourceRoot: string,
  guestRoot: string,
  protectedRoots: string[],
  dependencies: MirrorDependencies,
  registerCleanup: (registration: RegisteredWorktree) => void,
): Promise<RegisteredWorktree> {
  const worktreeRoot = await dependencies.makeTempRoot()
  const registration = { sourceRoot, worktreeRoot }
  registerCleanup(registration)
  const head = (await execGit(sourceRoot, ['rev-parse', 'HEAD'])).trim()
  await execGit(sourceRoot, ['worktree', 'add', '--detach', worktreeRoot, head])

  // The registered worktree, including its common-directory pointer, stays private to setup and
  // cleanup. Only the independently copied guestRoot is handed to the contained runtime.
  const mappedProtectedRoots = mapProtectedRoots(sourceRoot, worktreeRoot, protectedRoots)
  await copyStableTree(worktreeRoot, guestRoot, mappedProtectedRoots)

  const [headAfter, dirtyAfter] = await Promise.all([
    execGit(sourceRoot, ['rev-parse', 'HEAD']).then((value) => value.trim()),
    isDirtyWorktree(sourceRoot, { ignoreRoots: protectedRoots }),
  ])
  if (headAfter !== head || dirtyAfter) {
    throw new Error(CONTAINED_EXECUTION_SOURCE_CHANGED)
  }
  return registration
}

async function prepareWithDependencies(
  options: ContainedExecutionMirrorOptions,
  dependencies: MirrorDependencies,
): Promise<ContainedExecutionMirrorHandle> {
  const guestWorkspacePath = path.resolve(options.sourceRoot)
  const sourceRoot = canonicalPath(options.sourceRoot)
  const protectedRoots = protectedRootsWithinSource(sourceRoot, options.controlPlaneRoots ?? [])
  const guestRoot = await dependencies.makeTempRoot()
  const cleanupState: CleanupState = { guestRoot }

  try {
    const gitInspection = inspectGitResourceIdentity(sourceRoot)
    if (gitInspection.status === 'invalid') {
      throw new Error('contained_execution_git_identity_invalid')
    }
    if (
      gitInspection.status === 'resolved' &&
      (gitInspection.identity.repositoryRoot !== sourceRoot ||
        gitInspection.identity.gitDir === sourceRoot)
    ) {
      throw new Error('contained_execution_source_not_git_worktree_root')
    }
    const isRepositoryRoot = gitInspection.status === 'resolved'
    const cleanGit =
      isRepositoryRoot && !(await isDirtyWorktree(sourceRoot, { ignoreRoots: protectedRoots }))

    let backend: ContainedExecutionMirrorBackend = 'file_copy'
    if (cleanGit) {
      backend = 'clean_git_worktree'
      cleanupState.registeredWorktree = await prepareCleanGitCopy(
        sourceRoot,
        guestRoot,
        protectedRoots,
        dependencies,
        (registration) => {
          cleanupState.registeredWorktree = registration
        },
      )
    } else {
      await prepareFileCopy(sourceRoot, guestRoot, protectedRoots)
    }

    return {
      hostMirrorRoot: guestRoot,
      guestWorkspacePath,
      backend,
      cleanup: () => cleanupMirrorState(cleanupState, dependencies),
    }
  } catch (error) {
    try {
      await cleanupMirrorState(cleanupState, dependencies)
    } catch (cleanupError) {
      throw new ContainedExecutionCleanupUnconfirmedError(guestRoot, { cause: cleanupError })
    }
    throw error
  }
}

/**
 * Snapshot consistency rule:
 * - clean Git mirrors are bound to one detached HEAD and exposed only when HEAD and source
 *   cleanliness still match after materialization;
 * - dirty Git and non-Git mirrors are exposed only when source hashes before/after copy and the
 *   copied tree hash all agree.
 *
 * A persistent racing mutation or any mixed content captured by the copy fails setup closed.
 */
export function prepareContainedExecutionMirror(
  options: ContainedExecutionMirrorOptions,
): Promise<ContainedExecutionMirrorHandle> {
  return prepareWithDependencies(options, productionDependencies)
}

/** Narrow test seam for simulating allocation/removal failures; production callers use the API above. */
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
