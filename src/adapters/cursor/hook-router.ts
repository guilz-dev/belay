import { existsSync, readFileSync, realpathSync } from 'node:fs'
import path from 'node:path'

import { cursorLayout } from '../layouts/cursor.js'
import { findRepoRoot } from '../shared/repo-root.js'
import { resolveCursorActionCwdDetails } from './cwd-resolution.js'

export type CursorHookOrigin = { scope: 'project'; repoRoot: string } | { scope: 'global' }

export type CursorHookKind = 'before-submit' | 'shell-gate' | 'tool-gate' | 'audit'

export type CursorHookRoute =
  | { decision: 'execute'; repoRoot: string }
  | { decision: 'neutral' }
  | { decision: 'fail_closed'; message: string }

export interface RouteCursorHookParams {
  origin: CursorHookOrigin
  kind: CursorHookKind
  payload: Record<string, unknown>
}

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

function hookScriptFor(kind: CursorHookKind): string {
  if (kind === 'before-submit') {
    return 'belay-before-submit.mjs'
  }
  if (kind === 'shell-gate') {
    return 'belay-shell-gate.mjs'
  }
  if (kind === 'tool-gate') {
    return 'belay-tool-gate.mjs'
  }
  return 'belay-audit.mjs'
}

function payloadForKind(
  payload: Record<string, unknown>,
  kind: CursorHookKind,
): Record<string, unknown> {
  if (kind === 'before-submit' || kind === 'shell-gate') {
    return payload
  }
  if (kind === 'tool-gate' && payload.tool_name === 'Shell') {
    return payload
  }
  const toolInput = payload.tool_input
  if (toolInput === null || typeof toolInput !== 'object' || Array.isArray(toolInput)) {
    return payload
  }
  const { working_directory: _workingDirectory, ...withoutWorkingDirectory } = toolInput as Record<
    string,
    unknown
  >
  return { ...payload, tool_input: withoutWorkingDirectory }
}

function selectedActionPath(payload: Record<string, unknown>): string | undefined {
  const toolInput = payload.tool_input
  if (toolInput !== null && typeof toolInput === 'object' && !Array.isArray(toolInput)) {
    const workingDirectory = (toolInput as Record<string, unknown>).working_directory
    if (typeof workingDirectory === 'string' && workingDirectory.trim()) {
      return workingDirectory.trim()
    }
  }
  if (typeof payload.cwd === 'string' && payload.cwd.trim()) {
    return payload.cwd.trim()
  }
  if (!Array.isArray(payload.workspace_roots)) {
    return undefined
  }
  for (const root of payload.workspace_roots) {
    if (typeof root === 'string' && root.trim()) {
      return root.trim()
    }
  }
  return undefined
}

export function routeCursorHook(params: RouteCursorHookParams): CursorHookRoute {
  const relevantPayload = payloadForKind(params.payload, params.kind)
  const selectedPath = selectedActionPath(relevantPayload)
  if (!selectedPath || !path.isAbsolute(selectedPath)) {
    return { decision: 'fail_closed', message: 'belay could not determine the workspace.' }
  }
  const resolution = resolveCursorActionCwdDetails(relevantPayload, '/')
  const canonicalCwd = resolution.fromPayload ? canonicalExistingPath(resolution.cwd) : undefined
  if (!canonicalCwd) {
    return { decision: 'fail_closed', message: 'belay could not determine the workspace.' }
  }
  const repoRoot = canonicalExistingPath(findRepoRoot(canonicalCwd, cursorLayout))
  if (!repoRoot) {
    return { decision: 'neutral' }
  }
  try {
    const config = JSON.parse(readFileSync(cursorLayout.configPath(repoRoot), 'utf8')) as {
      installScope?: unknown
    }
    if (config.installScope === 'global') {
      return params.origin.scope === 'global'
        ? { decision: 'execute', repoRoot }
        : { decision: 'neutral' }
    }
    if (config.installScope !== 'project') {
      return { decision: 'neutral' }
    }
  } catch {
    return { decision: 'neutral' }
  }
  if (params.origin.scope !== 'project') {
    return { decision: 'neutral' }
  }
  if (canonicalExistingPath(params.origin.repoRoot) !== repoRoot) {
    return { decision: 'neutral' }
  }
  const hooksDir = cursorLayout.hooksDir(repoRoot)
  const complete = [
    path.join(hooksDir, hookScriptFor(params.kind)),
    path.join(hooksDir, 'belay-runner'),
    path.join(cursorLayout.runtimeDir(repoRoot), 'core.mjs'),
  ].every(existsSync)
  return complete
    ? { decision: 'execute', repoRoot }
    : { decision: 'fail_closed', message: 'belay project hook installation is incomplete.' }
}
