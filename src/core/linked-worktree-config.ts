import { execFile } from 'node:child_process'
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs'
import path from 'node:path'
import { promisify } from 'node:util'

import { getAdapterLayout } from '../adapters/layouts/index.js'
import type { AdapterName } from '../types.js'

const execFileAsync = promisify(execFile)

function canonicalWorktreePath(value: string): string {
  try {
    return realpathSync.native(value)
  } catch {
    return path.resolve(value)
  }
}

export async function listLinkedWorktreePaths(repoRoot: string): Promise<string[]> {
  try {
    const { stdout } = await execFileAsync('git', ['worktree', 'list', '--porcelain'], {
      cwd: repoRoot,
      encoding: 'utf8',
    })
    return stdout
      .split(/\r?\n/)
      .filter((line) => line.startsWith('worktree '))
      .map((line) => line.slice('worktree '.length).trim())
      .filter((entry) => entry.length > 0)
  } catch {
    return []
  }
}

export type RepoConfigFileReadResult =
  | { status: 'missing' }
  | { status: 'present'; config: unknown }
  | { status: 'unreadable' }

export interface RepoConfigResolution {
  repoConfig: unknown
  repoConfigPath?: string
  configSourceRoot: string
  inherited: boolean
}

export class RepoConfigReadError extends Error {
  readonly configPath: string

  constructor(configPath: string) {
    super(`Repository config is unreadable at ${configPath}.`)
    this.name = 'RepoConfigReadError'
    this.configPath = configPath
  }
}

export function isRepoConfigReadError(error: unknown): error is RepoConfigReadError {
  return error instanceof RepoConfigReadError
}

export function isPrimaryGitWorktree(repoRoot: string): boolean {
  const gitPath = path.join(repoRoot, '.git')
  try {
    return statSync(gitPath).isDirectory()
  } catch {
    return false
  }
}

export function sortWorktreesForConfigInheritance(worktrees: string[]): string[] {
  return [...worktrees].sort((left, right) => {
    const leftPrimary = isPrimaryGitWorktree(left)
    const rightPrimary = isPrimaryGitWorktree(right)
    if (leftPrimary !== rightPrimary) {
      return leftPrimary ? -1 : 1
    }
    return left.localeCompare(right)
  })
}

export function readRepoConfigFile(configPath: string): RepoConfigFileReadResult {
  if (!existsSync(configPath)) {
    return { status: 'missing' }
  }
  try {
    return { status: 'present', config: JSON.parse(readFileSync(configPath, 'utf8')) }
  } catch {
    return { status: 'unreadable' }
  }
}

export async function findInheritedRepoConfig(
  repoRoot: string,
  adapter: AdapterName,
): Promise<{ sourceRoot: string; configPath: string; repoConfig: unknown } | null> {
  const worktrees = await listLinkedWorktreePaths(repoRoot)
  if (worktrees.length === 0) {
    return null
  }

  const layout = getAdapterLayout(adapter)
  const resolvedRepoRoot = canonicalWorktreePath(repoRoot)
  for (const candidate of sortWorktreesForConfigInheritance(worktrees)) {
    if (canonicalWorktreePath(candidate) === resolvedRepoRoot) {
      continue
    }
    const configPath = layout.configPath(candidate)
    const readResult = readRepoConfigFile(configPath)
    if (readResult.status === 'present') {
      return { sourceRoot: candidate, configPath, repoConfig: readResult.config }
    }
  }
  return null
}

export async function resolveRepoConfig(
  repoRoot: string,
  adapter: AdapterName = 'cursor',
): Promise<RepoConfigResolution> {
  const layout = getAdapterLayout(adapter)
  const configPath = layout.configPath(repoRoot)
  const localConfig = readRepoConfigFile(configPath)
  if (localConfig.status === 'present') {
    return {
      repoConfig: localConfig.config,
      repoConfigPath: configPath,
      configSourceRoot: repoRoot,
      inherited: false,
    }
  }
  if (localConfig.status === 'unreadable') {
    throw new RepoConfigReadError(configPath)
  }

  const inherited = await findInheritedRepoConfig(repoRoot, adapter)
  if (inherited) {
    return {
      repoConfig: inherited.repoConfig,
      repoConfigPath: inherited.configPath,
      configSourceRoot: inherited.sourceRoot,
      inherited: true,
    }
  }

  return {
    repoConfig: {},
    configSourceRoot: repoRoot,
    inherited: false,
  }
}

export function effectiveDogfoodEnabled(config: {
  mode?: unknown
  policy?: { unknownLocalEffect?: unknown }
}): boolean {
  return config.mode === 'audit' && config.policy?.unknownLocalEffect === 'deny'
}
