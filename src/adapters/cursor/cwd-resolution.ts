import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export type CursorActionCwdSource =
  | 'tool_input.working_directory'
  | 'cwd'
  | 'workspace_roots'
  | 'fallback'

export interface CursorActionCwdResolution {
  cwd: string
  source: CursorActionCwdSource
  fromPayload: boolean
}

function nonEmptyPathString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined
}

export function resolveCursorActionCwdDetails(
  payload: Record<string, unknown>,
  fallback: string = process.cwd(),
): CursorActionCwdResolution {
  const toolInput = payload.tool_input
  const toolInputWorkingDirectory =
    toolInput !== null && typeof toolInput === 'object' && !Array.isArray(toolInput)
      ? nonEmptyPathString((toolInput as Record<string, unknown>).working_directory)
      : undefined
  const topLevelCwd = nonEmptyPathString(payload.cwd)
  const workspaceRoot = Array.isArray(payload.workspace_roots)
    ? payload.workspace_roots.map(nonEmptyPathString).find(Boolean)
    : undefined

  if (toolInputWorkingDirectory) {
    return {
      cwd: path.resolve(toolInputWorkingDirectory),
      source: 'tool_input.working_directory',
      fromPayload: true,
    }
  }
  if (topLevelCwd) {
    return {
      cwd: path.resolve(topLevelCwd),
      source: 'cwd',
      fromPayload: true,
    }
  }
  if (workspaceRoot) {
    return {
      cwd: path.resolve(workspaceRoot),
      source: 'workspace_roots',
      fromPayload: true,
    }
  }
  return {
    cwd: path.resolve(fallback),
    source: 'fallback',
    fromPayload: false,
  }
}

export function isGlobalCursorHookRuntime(): boolean {
  try {
    const runtimePath = path.resolve(fileURLToPath(import.meta.url))
    const globalRuntimeDir = path.resolve(path.join(os.homedir(), '.cursor', 'belay', 'runtime'))
    return (
      runtimePath === globalRuntimeDir || runtimePath.startsWith(`${globalRuntimeDir}${path.sep}`)
    )
  } catch {
    return false
  }
}

export function isUnsafeGlobalHookFallback(
  resolution: CursorActionCwdResolution,
  globalRuntime = isGlobalCursorHookRuntime(),
): boolean {
  return !resolution.fromPayload && globalRuntime
}

export const GLOBAL_HOOK_WORKSPACE_MISSING_MESSAGE =
  'belay could not determine the workspace for this action from the Cursor hook payload. ' +
  'Open the target project workspace and retry, or run belay doctor. ' +
  'To stop global hooks: belay uninstall --scope global'
