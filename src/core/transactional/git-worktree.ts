import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  rm,
  symlink,
} from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { canonicalPath, isPathOutsideRoot, pathWithinRoot } from '../path-utils.js'
import type { GitWorktreeSnapshot, TransactionalFileChange } from './types.js'

export const TRANSACTIONAL_APPLY_TOCTOU = 'transactional_apply_toctou'

function execGit(repoRoot: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', ['-C', repoRoot, ...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    child.stdout.on('data', (chunk) => stdout.push(Buffer.from(chunk)))
    child.stderr.on('data', (chunk) => stderr.push(Buffer.from(chunk)))
    child.on('error', reject)
    child.on('close', (code) => {
      if (code === 0) {
        resolve(Buffer.concat(stdout).toString('utf8'))
        return
      }
      reject(
        new Error(
          `git ${args.join(' ')} failed (${code}): ${Buffer.concat(stderr).toString('utf8').trim()}`,
        ),
      )
    })
  })
}

function porcelainRelativePath(line: string): string | null {
  if (line.length < 4) {
    return null
  }
  const relativePath = line.slice(3)
  return relativePath || null
}

function isIgnoredDirtyPath(
  repoRoot: string,
  relativePath: string,
  ignoreRoots: string[],
): boolean {
  if (ignoreRoots.length === 0) {
    return false
  }
  const absolutePath = canonicalPath(path.join(repoRoot, relativePath))
  return ignoreRoots.some(
    (root) =>
      pathWithinRoot(root, absolutePath) ||
      root === absolutePath ||
      pathWithinRoot(absolutePath, root),
  )
}

export async function hashRepoFile(filePath: string): Promise<string> {
  const info = await lstat(filePath)
  if (info.isSymbolicLink()) {
    return createHash('sha256')
      .update(`symlink:${await readlink(filePath)}`)
      .digest('hex')
  }
  if (!info.isFile()) {
    throw new Error('transactional_unsupported_file_kind')
  }
  const content = await readFile(filePath)
  return createHash('sha256')
    .update(`file:${info.mode & 0o777}:`)
    .update(content)
    .digest('hex')
}

export async function captureRepoFileHashes(
  repoRoot: string,
  changes: TransactionalFileChange[],
): Promise<Map<string, string | null>> {
  const hashes = new Map<string, string | null>()
  for (const change of changes) {
    const target = path.join(repoRoot, change.relativePath)
    try {
      await lstat(target)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      hashes.set(change.relativePath, null)
      continue
    }
    hashes.set(change.relativePath, await hashRepoFile(target))
  }
  return hashes
}

export async function isGitWorktreeAvailable(repoRoot: string): Promise<boolean> {
  try {
    await execGit(repoRoot, ['rev-parse', '--git-dir'])
    return true
  } catch {
    return false
  }
}

export async function isDirtyWorktree(
  repoRoot: string,
  options?: { ignoreRoots?: string[] },
): Promise<boolean> {
  try {
    const status = await execGit(repoRoot, ['status', '--porcelain'])
    const ignoreRoots = (options?.ignoreRoots ?? []).map((root) => canonicalPath(root))
    const repoRootCanonical = canonicalPath(repoRoot)

    for (const line of status.split('\n')) {
      if (!line.trim()) {
        continue
      }
      const relativePath = porcelainRelativePath(line)
      if (!relativePath) {
        continue
      }
      if (isIgnoredDirtyPath(repoRootCanonical, relativePath, ignoreRoots)) {
        continue
      }
      return true
    }
    return false
  } catch {
    return true
  }
}

export async function createGitWorktreeSnapshot(
  repoRoot: string,
  _stateDir: string,
): Promise<GitWorktreeSnapshot> {
  const worktreePath = await mkdtemp(path.join(os.tmpdir(), 'belay-tx-'))
  await execGit(repoRoot, ['worktree', 'add', '--detach', worktreePath, 'HEAD'])

  return {
    worktreePath,
    cleanup: async () => {
      try {
        await execGit(repoRoot, ['worktree', 'remove', '--force', worktreePath])
      } catch {
        await rm(worktreePath, { recursive: true, force: true })
        try {
          await execGit(repoRoot, ['worktree', 'prune'])
        } catch {
          // best effort
        }
      }
    },
  }
}

export function resolveWorktreeCwd(repoRoot: string, worktreePath: string, cwd: string): string {
  const resolvedCwd = canonicalPath(cwd)
  const relative = path.relative(canonicalPath(repoRoot), resolvedCwd)
  if (isPathOutsideRoot(relative) || path.isAbsolute(relative)) {
    return worktreePath
  }
  if (relative === '') {
    return worktreePath
  }
  return path.join(worktreePath, relative)
}

export interface ShellRunResult {
  exitCode: number | null
  signal: string | null
  timedOut: boolean
}

export function runShellCommand(
  command: string,
  cwd: string,
  timeoutMs: number,
): Promise<ShellRunResult> {
  return new Promise((resolve) => {
    const child = spawn(command, {
      cwd,
      shell: true,
      stdio: 'ignore',
      env: process.env,
    })
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGTERM')
    }, timeoutMs)

    child.on('error', () => {
      clearTimeout(timer)
      resolve({ exitCode: 1, signal: null, timedOut })
    })
    child.on('close', (exitCode, signal) => {
      clearTimeout(timer)
      resolve({
        exitCode,
        signal: signal ? String(signal) : null,
        timedOut,
      })
    })
  })
}

function parseStatusLine(line: string): TransactionalFileChange | null {
  if (line.length < 4) {
    return null
  }
  const status = line.slice(0, 2)
  const relativePath = line.slice(3)
  if (!relativePath) {
    return null
  }

  if (status.includes('D')) {
    return { relativePath, kind: 'deleted' }
  }
  if (status === '??') {
    return { relativePath, kind: 'added' }
  }
  if (status.includes('A') || status.includes('?')) {
    return { relativePath, kind: 'added' }
  }
  return { relativePath, kind: 'modified' }
}

export async function collectWorktreeChanges(
  worktreePath: string,
): Promise<TransactionalFileChange[]> {
  const status = await execGit(worktreePath, [
    'status',
    '--porcelain=v1',
    '-z',
    '-uall',
    '--no-renames',
  ])
  const changes: TransactionalFileChange[] = []
  const seen = new Set<string>()

  for (const line of status.split('\0')) {
    if (!line) {
      continue
    }
    const change = parseStatusLine(line)
    if (!change || seen.has(change.relativePath)) {
      continue
    }
    seen.add(change.relativePath)
    changes.push(change)
  }

  return changes
}

type ApplyRollbackAction =
  | { type: 'restore'; target: string; backupPath: string }
  | { type: 'remove'; target: string }

async function rollbackAppliedChanges(actions: ApplyRollbackAction[]): Promise<void> {
  for (const action of [...actions].reverse()) {
    try {
      if (action.type === 'restore') {
        await copyPathPreservingType(action.backupPath, action.target)
      } else {
        await rm(action.target, { force: true })
      }
    } catch {
      // best effort
    }
  }
}

async function copyPathPreservingType(source: string, target: string): Promise<void> {
  const info = await lstat(source)
  await rm(target, { force: true, recursive: false })
  await mkdir(path.dirname(target), { recursive: true })
  if (info.isSymbolicLink()) {
    await symlink(await readlink(source), target)
    return
  }
  if (!info.isFile()) {
    throw new Error('transactional_unsupported_file_kind')
  }
  await copyFile(source, target)
  await chmod(target, info.mode & 0o777)
}

async function assertRepoFilesUnchanged(
  repoRoot: string,
  changes: TransactionalFileChange[],
  baseHashes: Map<string, string | null>,
): Promise<void> {
  for (const change of changes) {
    const target = path.join(repoRoot, change.relativePath)
    const expected = baseHashes.get(change.relativePath)
    let exists = true
    try {
      await lstat(target)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      exists = false
    }

    if (expected === null) {
      if (exists) {
        throw new Error(TRANSACTIONAL_APPLY_TOCTOU)
      }
      continue
    }

    if (!exists) {
      throw new Error(TRANSACTIONAL_APPLY_TOCTOU)
    }

    const current = await hashRepoFile(target)
    if (current !== expected) {
      throw new Error(TRANSACTIONAL_APPLY_TOCTOU)
    }
  }
}

export async function applyWorktreeChanges(
  worktreePath: string,
  repoRoot: string,
  changes: TransactionalFileChange[],
  options?: {
    baseHashes?: Map<string, string | null>
    /** Runs while rollback backups are still available. */
    afterApply?: () => Promise<void>
  },
): Promise<void> {
  if (options?.baseHashes) {
    await assertRepoFilesUnchanged(repoRoot, changes, options.baseHashes)
  }

  const backupRoot = await mkdtemp(path.join(os.tmpdir(), 'belay-tx-rollback-'))
  const rollbackActions: ApplyRollbackAction[] = []

  try {
    for (const change of changes) {
      const target = path.join(repoRoot, change.relativePath)
      let targetExists = true
      try {
        await lstat(target)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        targetExists = false
      }
      if (targetExists) {
        const backupPath = path.join(backupRoot, change.relativePath)
        await mkdir(path.dirname(backupPath), { recursive: true })
        await copyPathPreservingType(target, backupPath)
        rollbackActions.push({ type: 'restore', target, backupPath })
      } else if (change.kind !== 'deleted') {
        rollbackActions.push({ type: 'remove', target })
      }

      if (change.kind === 'deleted') {
        await rm(target, { force: true })
        continue
      }

      const source = path.join(worktreePath, change.relativePath)
      await copyPathPreservingType(source, target)
    }
    await options?.afterApply?.()
  } catch (error) {
    await rollbackAppliedChanges(rollbackActions)
    throw error
  } finally {
    await rm(backupRoot, { recursive: true, force: true })
  }
}
