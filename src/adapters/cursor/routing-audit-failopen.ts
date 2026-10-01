import { existsSync, readFileSync, realpathSync } from 'node:fs'
import path from 'node:path'

import { resolveCursorActionCwdDetails } from './cwd-resolution.js'
import type { CursorHookKind, CursorHookOrigin } from './hook-router.js'
import { isTrustedCursorRoutingConfig } from './routing-config-trust.js'
import { cursorRoutingConfigPath, findCursorRoutingRepoRoot } from './routing-layout.js'

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

function nonEmptyPathString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function isAuditModeAtRepoRoot(repoRoot: string): boolean {
  const canonicalRoot = canonicalExistingPath(repoRoot)
  if (!canonicalRoot) {
    return false
  }
  try {
    const parsed: unknown = JSON.parse(readFileSync(cursorRoutingConfigPath(canonicalRoot), 'utf8'))
    return (
      parsed !== null &&
      typeof parsed === 'object' &&
      !Array.isArray(parsed) &&
      (parsed as Record<string, unknown>).mode === 'audit' &&
      isTrustedCursorRoutingConfig(canonicalRoot, parsed)
    )
  } catch {
    return false
  }
}

function payloadWorkspacePaths(payload: Record<string, unknown>): string[] {
  const paths: string[] = []
  const add = (value: string | undefined) => {
    if (!value) {
      return
    }
    const resolved = path.resolve(value)
    if (!paths.includes(resolved)) {
      paths.push(resolved)
    }
  }
  if (Array.isArray(payload.workspace_roots)) {
    for (const root of payload.workspace_roots) {
      add(nonEmptyPathString(root))
    }
  }
  const resolution = resolveCursorActionCwdDetails(payload, '/')
  if (resolution.fromPayload) {
    add(resolution.cwd)
  }
  return paths
}

function payloadIndicatesAuditMode(payload: Record<string, unknown>): boolean {
  for (const workspacePath of payloadWorkspacePaths(payload)) {
    const repoRoot = findCursorRoutingRepoRoot(workspacePath)
    if (isAuditModeAtRepoRoot(repoRoot)) {
      return true
    }
  }
  return false
}

export function shouldFailOpenRoutingInAudit(
  origin: CursorHookOrigin,
  kind: CursorHookKind,
  payload?: Record<string, unknown>,
): boolean {
  if (kind === 'audit') {
    return false
  }
  if (origin.scope === 'project') {
    return isAuditModeAtRepoRoot(origin.repoRoot)
  }
  if (origin.scope === 'global' && payload) {
    return payloadIndicatesAuditMode(payload)
  }
  return false
}
