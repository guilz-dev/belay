import { createHash } from 'node:crypto'
import { lstat, readdir } from 'node:fs/promises'
import path from 'node:path'

import type { BelayFileCheckpointConfig } from '../config.js'
import {
  compareRelativePathsBytewise,
  isExcludedTreePath,
  isNestedGitPath,
  joinRelativePath,
  validateRelativePath,
} from './file-tree-path.js'
import type { PresentSnapshotNode, SnapshotNode } from './snapshot-node.js'
import { hashDirectoryNode, readSnapshotNode, snapshotNodesEqual } from './snapshot-node.js'
import type { TransactionalFileChangeKind } from './types.js'

export const FILE_CHECKPOINT_HARDLINK_UNSUPPORTED = 'file_checkpoint_hardlink_unsupported'
export const FILE_CHECKPOINT_UNSUPPORTED_NODE = 'file_checkpoint_unsupported_node'
export const FILE_CHECKPOINT_NESTED_REPOSITORY = 'file_checkpoint_nested_repository'
export const FILE_CHECKPOINT_QUOTA_EXCEEDED = 'file_checkpoint_quota_exceeded'
export const FILE_CHECKPOINT_PREPARE_TIMEOUT = 'file_checkpoint_prepare_timeout'

export interface FileTreeEntry {
  relativePath: string
  node: PresentSnapshotNode
}

export interface FileTreeIndex {
  version: 1
  entries: FileTreeEntry[]
  treeHash: string
  fileCount: number
  directoryCount: number
  totalFileBytes: number
}

export interface ObservedFileChange {
  relativePath: string
  kind: TransactionalFileChangeKind
  before: SnapshotNode
  after: SnapshotNode
}

export interface FileTreeBuildOptions {
  resourceRoot: string
  excludedRoots?: string[]
  quotas?: Pick<BelayFileCheckpointConfig, 'maxFiles' | 'maxSourceBytes' | 'prepareTimeoutMs'>
  deadlineMs?: number
}

interface BuildCounters {
  fileCount: number
  directoryCount: number
  totalFileBytes: number
}

function assertWithinDeadline(deadlineMs: number | undefined): void {
  if (deadlineMs !== undefined && Date.now() > deadlineMs) {
    throw new Error(FILE_CHECKPOINT_PREPARE_TIMEOUT)
  }
}

function assertWithinQuotas(counters: BuildCounters, quotas: FileTreeBuildOptions['quotas']): void {
  if (!quotas) {
    return
  }
  const nodeCount = counters.fileCount + counters.directoryCount
  if (nodeCount > quotas.maxFiles) {
    throw new Error(FILE_CHECKPOINT_QUOTA_EXCEEDED)
  }
  if (counters.totalFileBytes > quotas.maxSourceBytes) {
    throw new Error(FILE_CHECKPOINT_QUOTA_EXCEEDED)
  }
}

async function readPresentNode(
  absolutePath: string,
  counters: BuildCounters,
): Promise<PresentSnapshotNode> {
  const info = await lstat(absolutePath)
  if (info.nlink > 1 && info.isFile()) {
    throw new Error(FILE_CHECKPOINT_HARDLINK_UNSUPPORTED)
  }
  if (info.isSocket() || info.isFIFO() || info.isBlockDevice() || info.isCharacterDevice()) {
    throw new Error(FILE_CHECKPOINT_UNSUPPORTED_NODE)
  }
  const node = await readSnapshotNode(absolutePath)
  if (node.kind === 'absent') {
    throw new Error(FILE_CHECKPOINT_UNSUPPORTED_NODE)
  }
  if (node.kind === 'file') {
    counters.fileCount += 1
    counters.totalFileBytes += node.size
  } else if (node.kind === 'directory') {
    counters.directoryCount += 1
  } else {
    counters.fileCount += 1
  }
  return node
}

async function walkDirectory(
  resourceRoot: string,
  relativeDir: string,
  excludedRoots: string[],
  counters: BuildCounters,
  quotas: FileTreeBuildOptions['quotas'],
  deadlineMs: number | undefined,
  entries: FileTreeEntry[],
): Promise<void> {
  assertWithinDeadline(deadlineMs)
  assertWithinQuotas(counters, quotas)

  const absoluteDir = relativeDir
    ? joinRelativePath(resourceRoot, relativeDir)
    : path.resolve(resourceRoot)
  const dirInfo = await lstat(absoluteDir)
  if (!dirInfo.isDirectory()) {
    throw new Error(FILE_CHECKPOINT_UNSUPPORTED_NODE)
  }

  if (relativeDir) {
    validateRelativePath(relativeDir)
    if (isNestedGitPath(relativeDir)) {
      throw new Error(FILE_CHECKPOINT_NESTED_REPOSITORY)
    }
    if (!isExcludedTreePath(relativeDir, excludedRoots, resourceRoot)) {
      entries.push({
        relativePath: relativeDir,
        node: {
          kind: 'directory',
          mode: dirInfo.mode,
          hash: hashDirectoryNode(dirInfo.mode),
        },
      })
      counters.directoryCount += 1
      assertWithinQuotas(counters, quotas)
    }
  }

  const names = await readdir(absoluteDir)
  for (const name of names) {
    assertWithinDeadline(deadlineMs)
    const childRelative = relativeDir ? path.join(relativeDir, name) : name
    validateRelativePath(childRelative)
    if (isNestedGitPath(childRelative)) {
      throw new Error(FILE_CHECKPOINT_NESTED_REPOSITORY)
    }
    if (isExcludedTreePath(childRelative, excludedRoots, resourceRoot)) {
      continue
    }

    const childAbsolute = path.join(absoluteDir, name)
    const childInfo = await lstat(childAbsolute)
    if (childInfo.isDirectory() && !childInfo.isSymbolicLink()) {
      await walkDirectory(
        resourceRoot,
        childRelative,
        excludedRoots,
        counters,
        quotas,
        deadlineMs,
        entries,
      )
      continue
    }

    const node = await readPresentNode(childAbsolute, counters)
    entries.push({ relativePath: childRelative, node })
    assertWithinQuotas(counters, quotas)
  }
}

export function computeTreeHash(entries: FileTreeEntry[]): string {
  const sorted = [...entries].sort((left, right) =>
    compareRelativePathsBytewise(left.relativePath, right.relativePath),
  )
  const hash = createHash('sha256')
  for (const entry of sorted) {
    hash.update(entry.relativePath)
    hash.update('\0')
    hash.update(entry.node.hash)
    hash.update('\0')
  }
  return hash.digest('hex')
}

export async function buildFileTreeIndex(options: FileTreeBuildOptions): Promise<FileTreeIndex> {
  const excludedRoots = options.excludedRoots ?? []
  const counters: BuildCounters = { fileCount: 0, directoryCount: 0, totalFileBytes: 0 }
  const deadlineMs =
    options.deadlineMs ??
    (options.quotas?.prepareTimeoutMs ? Date.now() + options.quotas.prepareTimeoutMs : undefined)
  const entries: FileTreeEntry[] = []

  await walkDirectory(
    options.resourceRoot,
    '',
    excludedRoots,
    counters,
    options.quotas,
    deadlineMs,
    entries,
  )

  const sortedEntries = [...entries].sort((left, right) =>
    compareRelativePathsBytewise(left.relativePath, right.relativePath),
  )

  return {
    version: 1,
    entries: sortedEntries,
    treeHash: computeTreeHash(sortedEntries),
    fileCount: counters.fileCount,
    directoryCount: counters.directoryCount,
    totalFileBytes: counters.totalFileBytes,
  }
}

function inferChangeKind(before: SnapshotNode, after: SnapshotNode): TransactionalFileChangeKind {
  if (before.kind === 'absent') {
    return 'added'
  }
  if (after.kind === 'absent') {
    return 'deleted'
  }
  return 'modified'
}

export function diffFileTreeIndices(
  baseline: FileTreeIndex,
  observed: FileTreeIndex,
): ObservedFileChange[] {
  const baselineMap = new Map(baseline.entries.map((entry) => [entry.relativePath, entry.node]))
  const observedMap = new Map(observed.entries.map((entry) => [entry.relativePath, entry.node]))
  const paths = new Set([...baselineMap.keys(), ...observedMap.keys()])
  const changes: ObservedFileChange[] = []

  for (const relativePath of [...paths].sort(compareRelativePathsBytewise)) {
    const before: SnapshotNode = baselineMap.get(relativePath) ?? { kind: 'absent' }
    const after: SnapshotNode = observedMap.get(relativePath) ?? { kind: 'absent' }
    if (snapshotNodesEqual(before, after)) {
      continue
    }
    changes.push({
      relativePath,
      kind: inferChangeKind(before, after),
      before,
      after,
    })
  }

  return changes
}

export async function readObservedChanges(
  baselineRoot: string,
  executionRoot: string,
  relativePaths: string[],
): Promise<ObservedFileChange[]> {
  const changes: ObservedFileChange[] = []
  for (const relativePath of relativePaths) {
    validateRelativePath(relativePath)
    const before = await readSnapshotNode(joinRelativePath(baselineRoot, relativePath))
    const after = await readSnapshotNode(joinRelativePath(executionRoot, relativePath))
    if (snapshotNodesEqual(before, after)) {
      continue
    }
    changes.push({
      relativePath,
      kind: inferChangeKind(before, after),
      before,
      after,
    })
  }
  return changes
}

// Re-export for tests that need direct content hashing without full walk.
export { hashFileContent, hashFileNode, hashSymlinkTarget } from './snapshot-node.js'
