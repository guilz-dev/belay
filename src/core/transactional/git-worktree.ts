import { spawn } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'

import { canonicalPath, isPathOutsideRoot, pathWithinRoot } from '../path-utils.js'
import { runProcessWithBoundedOutput, type ShellRunResult } from '../process-runner.js'
import {
  applyObservedChanges,
  buildObservedChangesFromTransactional,
  TRANSACTIONAL_APPLY_ROLLBACK_FAILED,
  TRANSACTIONAL_APPLY_TOCTOU,
} from './apply-observed-changes.js'
import type { GitWorktreeSnapshot, TransactionalFileChange } from './types.js'

export { TRANSACTIONAL_APPLY_ROLLBACK_FAILED, TRANSACTIONAL_APPLY_TOCTOU }

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
  const { mkdtemp, rm } = await import('node:fs/promises')
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

export type { ShellRunResult } from '../process-runner.js'

export function runShellCommand(
  command: string,
  cwd: string,
  timeoutMs: number,
): Promise<ShellRunResult> {
  return runProcessWithBoundedOutput(command, [], { cwd, shell: true, env: process.env }, timeoutMs)
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

export async function applyWorktreeChanges(
  worktreePath: string,
  repoRoot: string,
  changes: TransactionalFileChange[],
  options?: {
    /** Runs while rollback backups are still available. */
    afterApply?: () => Promise<void>
    observedChanges?: Awaited<ReturnType<typeof buildObservedChangesFromTransactional>>
  },
): Promise<void> {
  const observed =
    options?.observedChanges ??
    (await buildObservedChangesFromTransactional(repoRoot, worktreePath, changes))

  await applyObservedChanges({
    sourceRoot: worktreePath,
    targetRoot: repoRoot,
    changes: observed,
    afterApply: options?.afterApply,
  })
}
