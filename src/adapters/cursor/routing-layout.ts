import { existsSync } from 'node:fs'
import path from 'node:path'

export function cursorRoutingConfigPath(repoRoot: string): string {
  return path.join(repoRoot, '.cursor', 'belay.config.json')
}

export function cursorRoutingHooksDir(repoRoot: string): string {
  return path.join(repoRoot, '.cursor', 'hooks')
}

export function cursorRoutingHooksSettingsPath(repoRoot: string): string {
  return path.join(repoRoot, '.cursor', 'hooks.json')
}

export function cursorRoutingRuntimeDir(repoRoot: string): string {
  return path.join(repoRoot, '.cursor', 'belay', 'runtime')
}

export function findCursorRoutingRepoRoot(startPath: string): string {
  const resolvedStart = path.resolve(startPath)
  let current = resolvedStart
  while (true) {
    if (
      existsSync(path.join(current, '.git')) ||
      (existsSync(path.join(current, '.cursor')) && existsSync(cursorRoutingConfigPath(current)))
    ) {
      return current
    }
    const parent = path.dirname(current)
    if (parent === current) {
      return resolvedStart
    }
    current = parent
  }
}
