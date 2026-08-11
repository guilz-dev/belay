import { constants as fsConstants } from 'node:fs'
import {
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readlink,
  rm,
  symlink,
  utimes,
  writeFile,
} from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import type { BelayFileCheckpointConfig } from '../config.js'
import {
  buildFileTreeIndex,
  FILE_CHECKPOINT_QUOTA_EXCEEDED,
  FileCheckpointDiagnosticError,
} from './file-tree.js'
import { compareRelativePathsBytewise, joinRelativePath } from './file-tree-path.js'

export const FILE_CHECKPOINT_COPY_FAILED = 'file_checkpoint_copy_failed'

export type FileCloneStrategy = 'clonefile' | 'reflink' | 'copy'

export interface FileCloneOptions {
  excludedRoots?: string[]
  quotas?: Pick<
    BelayFileCheckpointConfig,
    'maxFiles' | 'maxSourceBytes' | 'maxWorkspaceBytes' | 'prepareTimeoutMs' | 'copyConcurrency'
  >
  deadlineMs?: number
}

export interface FileCloneResult {
  strategy: FileCloneStrategy
  sourceIndex: Awaited<ReturnType<typeof buildFileTreeIndex>>
}

async function chmodSafe(target: string, mode: number): Promise<void> {
  try {
    const { chmod } = await import('node:fs/promises')
    await chmod(target, mode & 0o777)
  } catch {
    // best effort
  }
}

async function copyRegularFile(
  sourcePath: string,
  destinationPath: string,
  mode: number,
  strategy: FileCloneStrategy,
): Promise<FileCloneStrategy> {
  await mkdir(path.dirname(destinationPath), { recursive: true })
  if (strategy === 'clonefile' && fsConstants.COPYFILE_FICLONE !== undefined) {
    try {
      await copyFile(sourcePath, destinationPath, fsConstants.COPYFILE_FICLONE)
      await chmodSafe(destinationPath, mode)
      return 'clonefile'
    } catch {
      await copyFile(sourcePath, destinationPath)
      await chmodSafe(destinationPath, mode)
      return 'copy'
    }
  }
  await copyFile(sourcePath, destinationPath)
  await chmodSafe(destinationPath, mode)
  return strategy
}

async function copyNode(
  sourceRoot: string,
  destinationRoot: string,
  relativePath: string,
  strategy: FileCloneStrategy,
): Promise<FileCloneStrategy> {
  const sourcePath = joinRelativePath(sourceRoot, relativePath)
  const destinationPath = joinRelativePath(destinationRoot, relativePath)
  const info = await lstat(sourcePath)

  await rm(destinationPath, { force: true, recursive: false })
  if (info.isDirectory() && !info.isSymbolicLink()) {
    await mkdir(destinationPath, { recursive: true, mode: info.mode & 0o777 })
    return strategy
  }
  if (info.isSymbolicLink()) {
    await mkdir(path.dirname(destinationPath), { recursive: true })
    await symlink(await readlink(sourcePath), destinationPath)
    return strategy
  }
  if (!info.isFile()) {
    throw new Error(FILE_CHECKPOINT_COPY_FAILED)
  }

  const usedStrategy = await copyRegularFile(sourcePath, destinationPath, info.mode, strategy)
  try {
    await utimes(destinationPath, info.atime, info.mtime)
  } catch {
    // best effort
  }
  return usedStrategy
}

export async function cloneDirectoryTree(
  sourceRoot: string,
  destinationRoot: string,
  options: FileCloneOptions = {},
): Promise<FileCloneResult> {
  const sourceIndex = await buildFileTreeIndex({
    resourceRoot: sourceRoot,
    excludedRoots: options.excludedRoots,
    quotas: options.quotas,
    deadlineMs: options.deadlineMs,
  })

  if (options.quotas && sourceIndex.totalFileBytes * 2 > options.quotas.maxWorkspaceBytes) {
    throw new FileCheckpointDiagnosticError(
      FILE_CHECKPOINT_QUOTA_EXCEEDED,
      `estimated workspaceBytes=${sourceIndex.totalFileBytes * 2} exceeds maxWorkspaceBytes=${options.quotas.maxWorkspaceBytes}`,
    )
  }

  const sortedPaths = [...sourceIndex.entries]
    .map((entry) => entry.relativePath)
    .sort(compareRelativePathsBytewise)

  const concurrency = options.quotas?.copyConcurrency ?? 1
  const strategyState: { value: FileCloneStrategy } = { value: 'clonefile' }

  await mapWithConcurrency(sortedPaths, concurrency, async (relativePath) => {
    const used = await copyNode(sourceRoot, destinationRoot, relativePath, strategyState.value)
    if (used === 'copy') {
      strategyState.value = 'copy'
    }
  })

  return { strategy: strategyState.value, sourceIndex }
}

async function mapWithConcurrency<T>(
  items: T[],
  concurrency: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  if (items.length === 0) {
    return
  }
  const limit = Math.max(1, Math.min(concurrency, items.length))
  let nextIndex = 0
  async function runWorker(): Promise<void> {
    while (nextIndex < items.length) {
      const index = nextIndex
      nextIndex += 1
      await worker(items[index])
    }
  }
  await Promise.all(Array.from({ length: limit }, () => runWorker()))
}

export async function probeFileCloneStrategy(): Promise<FileCloneStrategy> {
  let tempDir: string | null = null
  try {
    tempDir = await mkdtemp(path.join(os.tmpdir(), 'belay-clone-probe-'))
    const source = path.join(tempDir, 'source.txt')
    const destination = path.join(tempDir, 'dest.txt')
    await writeFile(source, 'probe\n')

    if (fsConstants.COPYFILE_FICLONE_FORCE !== undefined) {
      try {
        await copyFile(source, destination, fsConstants.COPYFILE_FICLONE_FORCE)
        return 'clonefile'
      } catch {
        // fall through to clonefile or copy
      }
    }
    if (fsConstants.COPYFILE_FICLONE !== undefined) {
      try {
        await copyFile(source, destination, fsConstants.COPYFILE_FICLONE)
        return 'clonefile'
      } catch {
        return 'copy'
      }
    }
    return 'copy'
  } catch {
    return 'copy'
  } finally {
    if (tempDir) {
      try {
        await rm(tempDir, { recursive: true, force: true })
      } catch {
        // best effort cleanup
      }
    }
  }
}
