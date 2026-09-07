import { realpathSync } from 'node:fs'
import path from 'node:path'

export const CURSOR_PROJECT_HOOK_REPO_ROOT_RESOLVER =
  "path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')"

export function renderCursorProjectHookRepoRoot(): string {
  return `const repoRoot = ${CURSOR_PROJECT_HOOK_REPO_ROOT_RESOLVER}`
}

export function hasDynamicProjectHookShim(source: string): boolean {
  return (
    source.includes("from '../belay/runtime/dispatcher.mjs'") &&
    source.includes(CURSOR_PROJECT_HOOK_REPO_ROOT_RESOLVER) &&
    source.includes("scope: 'project'") &&
    source.includes('repoRoot')
  )
}

export function hasLegacyProjectHookShim(source: string, repoRoot: string): boolean {
  let canonicalRepoRoot = repoRoot
  try {
    canonicalRepoRoot = realpathSync(repoRoot)
  } catch {
    canonicalRepoRoot = path.resolve(repoRoot)
  }
  return (
    source.includes("from '../belay/runtime/dispatcher.mjs'") &&
    source.includes(`origin: ${JSON.stringify({ scope: 'project', repoRoot: canonicalRepoRoot })}`)
  )
}

export function hasManagedProjectHookShim(source: string, repoRoot: string): boolean {
  return hasDynamicProjectHookShim(source) || hasLegacyProjectHookShim(source, repoRoot)
}
