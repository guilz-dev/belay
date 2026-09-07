import { realpathSync } from 'node:fs'
import path from 'node:path'

export const CURSOR_PROJECT_HOOK_REPO_ROOT_RESOLVER =
  "path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')"

const CURSOR_PROJECT_HOOK_DISPATCH_RE =
  /await\s+dispatchCursorHook\(\{\s*origin:\s*\{\s*scope:\s*'project',\s*repoRoot\s*\},/

export function renderCursorProjectHookRepoRoot(): string {
  return `const repoRoot = ${CURSOR_PROJECT_HOOK_REPO_ROOT_RESOLVER}`
}

export function hasCursorDispatcherShim(source: string): boolean {
  return source.includes("from '../belay/runtime/dispatcher.mjs'")
}

export function hasDynamicProjectHookShim(source: string): boolean {
  return (
    hasCursorDispatcherShim(source) &&
    source.includes(renderCursorProjectHookRepoRoot()) &&
    CURSOR_PROJECT_HOOK_DISPATCH_RE.test(source)
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
    hasCursorDispatcherShim(source) &&
    source.includes(`origin: ${JSON.stringify({ scope: 'project', repoRoot: canonicalRepoRoot })}`)
  )
}

export function hasManagedProjectHookShim(source: string, repoRoot: string): boolean {
  return hasDynamicProjectHookShim(source) || hasLegacyProjectHookShim(source, repoRoot)
}
