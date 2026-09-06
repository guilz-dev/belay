import { existsSync, readFileSync, realpathSync } from 'node:fs'

import {
  CURSOR_GLOBAL_SENTINEL_BLOCK_MESSAGE,
  routeCursorHook,
  type CursorHookKind,
} from './hook-router.js'
import { cursorRoutingConfigPath } from './routing-layout.js'

const SENTINEL_KINDS: CursorHookKind[] = ['before-submit', 'shell-gate']

function canonicalRepoRoot(repoRoot: string): string {
  try {
    return realpathSync(repoRoot)
  } catch {
    return repoRoot
  }
}

function configuredInstallScope(repoRoot: string): 'project' | 'global' | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(cursorRoutingConfigPath(repoRoot), 'utf8'))
  } catch {
    return undefined
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return undefined
  }
  return (parsed as Record<string, unknown>).installScope === 'global' ? 'global' : 'project'
}

function upgradeCommand(repoRoot: string, installScope: 'project' | 'global'): string {
  return `belay upgrade --scope ${installScope} --target ${JSON.stringify(repoRoot)}`
}

export function cursorHookRoutingIssues(repoRoot: string): string[] {
  if (!existsSync(cursorRoutingConfigPath(repoRoot))) {
    return []
  }
  const canonicalRoot = canonicalRepoRoot(repoRoot)
  const payload = { cwd: canonicalRoot, workspace_roots: [canonicalRoot] }
  const installScope = configuredInstallScope(repoRoot) ?? 'project'
  const issues: string[] = []
  for (const kind of SENTINEL_KINDS) {
    const route = routeCursorHook({
      origin: { scope: 'global' },
      kind,
      payload,
    })
    if (route.decision !== 'fail_closed') {
      continue
    }
    if (route.message.includes(CURSOR_GLOBAL_SENTINEL_BLOCK_MESSAGE)) {
      issues.push(
        `Global Cursor sentinel would block ${kind} in this workspace. Run ${upgradeCommand(repoRoot, installScope)}; if the config was edited manually, also run belay config trust --target ${JSON.stringify(repoRoot)}.`,
      )
      continue
    }
    issues.push(`Global Cursor sentinel would block ${kind}: ${route.message}`)
  }
  return issues
}
