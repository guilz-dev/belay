import { existsSync, realpathSync } from 'node:fs'
import path from 'node:path'

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

export function pathWithinRoot(root: string, targetPath: string): boolean {
  const resolvedRoot = canonicalPath(root)
  const resolvedTarget = canonicalPath(targetPath)
  const relativePath = path.relative(resolvedRoot, resolvedTarget)
  if (relativePath === '') {
    return true
  }
  return !relativePath.startsWith('..') && !path.isAbsolute(relativePath)
}

export function relativeWithinRepo(repoRoot: string, targetPath: string): string | null {
  const resolvedRoot = canonicalPath(repoRoot)
  const resolvedTarget = canonicalPath(targetPath)
  const relativePath = path.relative(resolvedRoot, resolvedTarget)
  if (relativePath === '') {
    return '.'
  }
  if (relativePath.startsWith('..')) {
    return null
  }
  return relativePath
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
  if (token === '2>' || token === '1>' || token === '&>' || token === '1>>' || token === '2>>') {
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
    return relativeWithinRepo(repoRoot, resolved) === null
  })
}
