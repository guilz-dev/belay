import { existsSync, readFileSync, realpathSync } from 'node:fs'

import type { CursorHookKind, CursorHookOrigin } from './hook-router.js'
import { cursorRoutingConfigPath } from './routing-layout.js'

function canonicalExistingPath(value: string): string | undefined {
  if (!existsSync(value)) {
    return undefined
  }
  try {
    return realpathSync(value)
  } catch {
    return undefined
  }
}

function isProjectAuditMode(origin: CursorHookOrigin): boolean {
  if (origin.scope !== 'project') {
    return false
  }
  const repoRoot = canonicalExistingPath(origin.repoRoot)
  if (!repoRoot) {
    return false
  }
  try {
    const parsed: unknown = JSON.parse(readFileSync(cursorRoutingConfigPath(repoRoot), 'utf8'))
    return (
      parsed !== null &&
      typeof parsed === 'object' &&
      !Array.isArray(parsed) &&
      (parsed as Record<string, unknown>).mode === 'audit'
    )
  } catch {
    return false
  }
}

export function shouldFailOpenRoutingInAudit(
  origin: CursorHookOrigin,
  kind: CursorHookKind,
): boolean {
  if (kind === 'audit') {
    return false
  }
  return isProjectAuditMode(origin)
}
