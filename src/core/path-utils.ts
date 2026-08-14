import { existsSync, realpathSync } from 'node:fs'
import path from 'node:path'
import { inspectGitResourceIdentity } from './git-resource-identity.js'
import { isFdDuplication, isRedirectOperator } from './shell-tokenizer.js'

/**
 * Resolve symlinks for the longest existing prefix of `targetPath`, then append
 * any non-existent suffix without further resolution. Keeps path comparisons
 * symmetric when one side is a not-yet-created file (e.g. transactional diff,
 * fs-scope allowlist matching).
 */
export function canonicalPath(targetPath: string): string {
  const resolved = path.resolve(targetPath)
  if (!resolved) {
    return resolved
  }

  const parsed = path.parse(resolved)
  let current = parsed.root
  const relativeParts = path
    .relative(parsed.root || '.', resolved)
    .split(path.sep)
    .filter(Boolean)

  for (let i = 0; i < relativeParts.length; i++) {
    const segment = relativeParts[i]
    if (!segment) {
      continue
    }
    const candidate = current === '' ? segment : path.join(current, segment)
    if (!existsSync(candidate)) {
      return path.join(candidate, ...relativeParts.slice(i + 1))
    }
    try {
      current = realpathSync.native(candidate)
    } catch {
      return path.join(candidate, ...relativeParts.slice(i + 1))
    }
  }

  return current
}

export function isPathOutsideRoot(relativePath: string): boolean {
  return relativePath === '..' || relativePath.startsWith(`..${path.sep}`)
}

export function pathWithinRoot(root: string, targetPath: string): boolean {
  const resolvedRoot = canonicalPath(root)
  const resolvedTarget = canonicalPath(targetPath)
  const relativePath = path.relative(resolvedRoot, resolvedTarget)
  if (relativePath === '') {
    return true
  }
  return !isPathOutsideRoot(relativePath) && !path.isAbsolute(relativePath)
}

function relativeWithinRoot(
  root: string,
  targetPath: string,
  options: { canonicalizeRoot?: boolean } = {},
): string | null {
  const resolvedRoot = options.canonicalizeRoot === false ? path.resolve(root) : canonicalPath(root)
  const resolvedTarget = canonicalPath(targetPath)
  const relativePath = path.relative(resolvedRoot, resolvedTarget)
  if (relativePath === '') {
    return '.'
  }
  if (isPathOutsideRoot(relativePath) || path.isAbsolute(relativePath)) {
    return null
  }
  return relativePath
}

export function relativeWithinRepo(repoRoot: string, targetPath: string): string | null {
  return relativeWithinRoot(repoRoot, targetPath)
}

export type WorkspaceRootMatch =
  | { kind: 'repo'; root: string; relativePath: string }
  | { kind: 'trusted'; root: string; relativePath: string }

export function resolveWorkspaceRootMatch(
  repoRoot: string,
  trustedRoots: string[] = [],
  targetPath: string,
): WorkspaceRootMatch | null {
  const canonicalRepoRoot = canonicalPath(repoRoot)
  const repoInspection = inspectGitResourceIdentity(repoRoot)
  const targetInspection = inspectGitResourceIdentity(targetPath)
  if (repoInspection.status === 'resolved') {
    if (targetInspection.status === 'resolved') {
      if (repoInspection.identity.commonDir === targetInspection.identity.commonDir) {
        const relativePath = relativeWithinRoot(
          targetInspection.identity.repositoryRoot,
          targetPath,
        )
        if (relativePath !== null) {
          return {
            kind: 'repo',
            root: targetInspection.identity.repositoryRoot,
            relativePath,
          }
        }
      }
      return null
    }
    if (targetInspection.status === 'invalid') {
      return null
    }
    if (relativeWithinRoot(repoRoot, targetPath) !== null) {
      return null
    }
  } else if (repoInspection.status === 'invalid') {
    if (relativeWithinRoot(repoRoot, targetPath) !== null || targetInspection.status !== 'absent') {
      return null
    }
  } else if (targetInspection.status === 'absent') {
    const repoRelative = relativeWithinRoot(repoRoot, targetPath)
    if (repoRelative !== null) {
      return { kind: 'repo', root: canonicalRepoRoot, relativePath: repoRelative }
    }
  } else {
    return null
  }

  const normalizedTrustedRoots = [...new Set(trustedRoots.map((root) => path.resolve(root)))]
    .filter((root) => root !== canonicalRepoRoot)
    .sort((left, right) => right.length - left.length)
  for (const root of normalizedTrustedRoots) {
    const trustedRelative = relativeWithinRoot(root, targetPath, { canonicalizeRoot: false })
    if (trustedRelative !== null) {
      return { kind: 'trusted', root, relativePath: trustedRelative }
    }
  }
  return null
}

export function normalizeToken(token: string, repoRoot: string): string {
  if (!path.isAbsolute(token)) {
    return token
  }
  const relativePath = relativeWithinRepo(repoRoot, token)
  return relativePath ?? token
}

export function resolveMutationTarget(token: string, cwd: string): string | null {
  if (!token || token === '--' || token.startsWith('-')) {
    return null
  }
  if (
    isRedirectOperator(token) ||
    isFdDuplication(token) ||
    token === '&&' ||
    token === '||' ||
    token === '|' ||
    token === '|&' ||
    token === ';' ||
    token === '&'
  ) {
    return null
  }
  if (path.isAbsolute(token)) {
    return canonicalPath(token)
  }
  if (token.startsWith('./') || token.startsWith('../')) {
    return canonicalPath(path.resolve(cwd, token))
  }
  if (!token.includes('/') && !token.includes('\\')) {
    return canonicalPath(path.resolve(cwd, token))
  }
  return canonicalPath(path.resolve(cwd, token))
}

function looksLikePathToken(token: string): boolean {
  if (!token || token === '--' || token.startsWith('-')) {
    return false
  }
  if (path.isAbsolute(token)) {
    return true
  }
  if (token.startsWith('./') || token.startsWith('../')) {
    return true
  }
  return token.includes('/') || token.includes('\\')
}

export function hasOutsideRepoPath(tokens: string[], cwd: string, repoRoot: string): boolean {
  return tokens.some((token) => {
    if (!looksLikePathToken(token)) {
      return false
    }
    const resolved = resolveMutationTarget(token, cwd)
    if (!resolved) {
      return false
    }
    return resolveWorkspaceRootMatch(repoRoot, [], resolved) === null
  })
}

export function containingGitRoot(targetPath: string): string | null {
  const inspection = inspectGitResourceIdentity(targetPath)
  if (inspection.status === 'resolved') {
    return inspection.identity.repositoryRoot
  }
  return inspection.status === 'invalid' ? inspection.boundaryPath : null
}
