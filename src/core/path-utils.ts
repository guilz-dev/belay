import { realpathSync } from 'node:fs'
import path from 'node:path'

function resolveRealpath(targetPath: string): string {
  try {
    return realpathSync.native(targetPath)
  } catch {
    return path.resolve(targetPath)
  }
}

export function pathWithinRoot(root: string, targetPath: string): boolean {
  const resolvedRoot = resolveRealpath(root)
  const resolvedTarget = resolveRealpath(targetPath)
  const relativePath = path.relative(resolvedRoot, resolvedTarget)
  if (relativePath === '') {
    return true
  }
  return !relativePath.startsWith('..') && !path.isAbsolute(relativePath)
}

export function relativeWithinRepo(repoRoot: string, targetPath: string): string | null {
  const resolvedRoot = resolveRealpath(repoRoot)
  const resolvedTarget = resolveRealpath(targetPath)
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
    return resolveRealpath(token)
  }
  if (token.startsWith('./') || token.startsWith('../')) {
    return resolveRealpath(path.resolve(cwd, token))
  }
  if (!token.includes('/') && !token.includes('\\')) {
    return resolveRealpath(path.resolve(cwd, token))
  }
  return resolveRealpath(path.resolve(cwd, token))
}

export function hasOutsideRepoPath(tokens: string[], cwd: string, repoRoot: string): boolean {
  return tokens.some((token) => {
    const resolved = resolveMutationTarget(token, cwd)
    if (!resolved) {
      return false
    }
    return relativeWithinRepo(repoRoot, resolved) === null
  })
}
