import { realpathSync } from 'node:fs'
import path from 'node:path'

export const CURSOR_PROJECT_HOOK_REPO_ROOT_RESOLVER =
  "path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')"

const CURSOR_PROJECT_HOOKS = [
  ['before-submit', '"beforeSubmitPrompt"'],
  ['shell-gate', '"beforeShellExecution"'],
  ['tool-gate', "process.argv[2] ?? 'preToolUse'"],
  ['audit', "process.argv[2] ?? 'postToolUse'"],
] as const

export function renderCursorProjectHookRepoRoot(): string {
  return `const repoRoot = ${CURSOR_PROJECT_HOOK_REPO_ROOT_RESOLVER}`
}

export function renderCursorProjectHookShim(kind: string, eventName: string): string {
  return `import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { dispatchCursorHook } from '../belay/runtime/dispatcher.mjs'

${renderCursorProjectHookRepoRoot()}

await dispatchCursorHook({
  origin: { scope: 'project', repoRoot },
  kind: ${JSON.stringify(kind)},
  eventName: ${eventName},
})
`
}

function renderLegacyProjectHookShim(kind: string, eventName: string, repoRoot: string): string {
  return `import { dispatchCursorHook } from '../belay/runtime/dispatcher.mjs'

await dispatchCursorHook({
  origin: ${JSON.stringify({ scope: 'project', repoRoot })},
  kind: ${JSON.stringify(kind)},
  eventName: ${eventName},
})
`
}

export function hasCursorDispatcherShim(source: string): boolean {
  return source.includes("from '../belay/runtime/dispatcher.mjs'")
}

export function hasDynamicProjectHookShim(source: string): boolean {
  return CURSOR_PROJECT_HOOKS.some(
    ([kind, eventName]) => source === renderCursorProjectHookShim(kind, eventName),
  )
}

export function hasLegacyProjectHookShim(source: string, repoRoot: string): boolean {
  let canonicalRepoRoot = repoRoot
  try {
    canonicalRepoRoot = realpathSync(repoRoot)
  } catch {
    canonicalRepoRoot = path.resolve(repoRoot)
  }
  return CURSOR_PROJECT_HOOKS.some(
    ([kind, eventName]) =>
      source === renderLegacyProjectHookShim(kind, eventName, canonicalRepoRoot),
  )
}

export function hasManagedProjectHookShim(source: string, repoRoot: string): boolean {
  return hasDynamicProjectHookShim(source) || hasLegacyProjectHookShim(source, repoRoot)
}
