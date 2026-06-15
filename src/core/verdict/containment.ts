import path from 'node:path'
import { matchesSensitivePath } from '../glob.js'
import {
  canonicalPath,
  pathWithinRoot,
  relativeWithinRepo,
  resolveMutationTarget,
} from '../path-utils.js'

import { isOutsideRepoSecretCredentialPath } from './persistent-paths.js'

export { isOutsideRepoSecretCredentialPath, isPersistentAgentPath } from './persistent-paths.js'

import type { VerdictLocation } from './types.js'

export interface PathTargetAnalysis {
  location: VerdictLocation
  isHighStakes: boolean
  signals: string[]
}

function expandHome(token: string): string {
  if (token === '~' || token.startsWith('~/')) {
    const home = process.env.HOME ?? process.env.USERPROFILE ?? ''
    if (!home) {
      return token
    }
    return token === '~' ? home : path.join(home, token.slice(2))
  }
  return token
}

export function resolveTrustedPath(
  token: string,
  trustedCwd: string,
  trusted: boolean,
): string | null {
  if (!token || token === '--' || token.startsWith('-')) {
    return null
  }
  if (!trusted || !trustedCwd) {
    return null
  }
  const expanded = expandHome(token)
  if (path.isAbsolute(expanded)) {
    return canonicalPath(expanded)
  }
  return canonicalPath(path.resolve(trustedCwd, expanded))
}

export function locationForPath(resolvedPath: string | null, repoRoot: string): VerdictLocation {
  if (!resolvedPath) {
    return 'unknown'
  }
  if (pathWithinRoot(repoRoot, resolvedPath)) {
    return 'repo_local'
  }
  return 'repo_outside'
}

export function isGitPath(resolvedPath: string, repoRoot: string): boolean {
  const relative = relativeWithinRepo(repoRoot, resolvedPath)
  if (!relative) {
    return false
  }
  const normalized = relative.replaceAll('\\', '/')
  return normalized === '.git' || normalized.startsWith('.git/')
}

export function isHighStakesPath(
  resolvedPath: string,
  repoRoot: string,
  sensitivePaths: string[],
  protectedRoots: string[] = [],
): boolean {
  if (isGitPath(resolvedPath, repoRoot)) {
    return true
  }
  const relative = relativeWithinRepo(repoRoot, resolvedPath)
  if (relative !== null && matchesSensitivePath(relative.replaceAll('\\', '/'), sensitivePaths)) {
    return true
  }
  if (relative === null && isOutsideRepoSecretCredentialPath(resolvedPath)) {
    return true
  }
  return protectedRoots.some((root) => pathWithinRoot(root, resolvedPath))
}

const DESTRUCTIVE_MUTATION_HEADS = new Set([
  'rm',
  'shred',
  'truncate',
  'dd',
  'chmod',
  'chown',
  'mv',
  'cp',
])

/** ADR-002 M3: destructive shell head on git/sensitive path (not broad category ask). */
export function isDestructiveMutationHead(head: string): boolean {
  return DESTRUCTIVE_MUTATION_HEADS.has(head)
}

export function touchesProtectedRoot(resolvedPath: string, protectedRoots: string[]): boolean {
  return protectedRoots.some((root) => pathWithinRoot(root, resolvedPath) || root === resolvedPath)
}

export function isDestructiveHighStakesMutation(
  head: string,
  resolvedPath: string,
  repoRoot: string,
  sensitivePaths: string[],
  protectedRoots: string[] = [],
): boolean {
  if (touchesProtectedRoot(resolvedPath, protectedRoots)) {
    return true
  }
  if (!isDestructiveMutationHead(head)) {
    return false
  }
  return isHighStakesPath(resolvedPath, repoRoot, sensitivePaths, [])
}

export function analyzePathTargets(params: {
  targets: string[]
  cwd: string
  repoRoot: string
  trustedCwd: boolean
  sensitivePaths: string[]
  protectedArtifactRoots?: string[]
}): PathTargetAnalysis {
  const signals: string[] = []
  if (!params.trustedCwd || !params.cwd) {
    return {
      location: 'unknown',
      isHighStakes: false,
      signals: ['missing_trusted_cwd'],
    }
  }

  const locations = new Set<VerdictLocation>()
  let isHighStakes = false

  for (const target of params.targets) {
    const resolved =
      resolveTrustedPath(target, params.cwd, params.trustedCwd) ??
      resolveMutationTarget(target, params.cwd)
    const location = locationForPath(resolved, params.repoRoot)
    locations.add(location)
    if (
      resolved &&
      isHighStakesPath(
        resolved,
        params.repoRoot,
        params.sensitivePaths,
        params.protectedArtifactRoots,
      )
    ) {
      isHighStakes = true
      signals.push('high_stakes_path')
    }
  }

  let location: VerdictLocation = 'unknown'
  if (locations.size === 0) {
    location = 'unknown'
  } else if (locations.size === 1) {
    location = [...locations][0] ?? 'unknown'
  } else {
    location = 'mixed'
  }

  return { location, isHighStakes, signals }
}

export function cwdRelative(repoRoot: string, cwd: string): string {
  return relativeWithinRepo(repoRoot, cwd) ?? cwd
}
