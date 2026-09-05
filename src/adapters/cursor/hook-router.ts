import { accessSync, constants, existsSync, readFileSync, realpathSync, statSync } from 'node:fs'
import path from 'node:path'

import { resolveCursorActionCwdDetails } from './cwd-resolution.js'
import { isTrustedCursorRoutingConfig } from './routing-config-trust.js'
import {
  cursorRoutingConfigPath,
  cursorRoutingHooksDir,
  cursorRoutingHooksSettingsPath,
  cursorRoutingRuntimeDir,
  findCursorRoutingRepoRoot,
} from './routing-layout.js'

export type CursorHookOrigin = { scope: 'project'; repoRoot: string } | { scope: 'global' }

export type CursorHookKind = 'before-submit' | 'shell-gate' | 'tool-gate' | 'audit'

export type CursorHookRoute =
  | { decision: 'execute'; repoRoot: string }
  | { decision: 'neutral' }
  | { decision: 'fail_closed'; message: string }

export interface RouteCursorHookParams {
  origin: CursorHookOrigin
  kind: CursorHookKind
  eventName?: string
  payload: Record<string, unknown>
}

type RoutingInstallScope = 'missing' | 'project' | 'global'

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

function hookCommandFor(kind: CursorHookKind): string {
  return hookScriptFor(kind).replace(/\.mjs$/, '')
}

function eventNameFor(params: RouteCursorHookParams): string {
  if (params.eventName) {
    return params.eventName
  }
  if (params.kind === 'before-submit') {
    return 'beforeSubmitPrompt'
  }
  if (params.kind === 'shell-gate') {
    return 'beforeShellExecution'
  }
  if (params.kind === 'tool-gate') {
    return typeof params.payload.subagent_type === 'string' ? 'subagentStart' : 'preToolUse'
  }
  if (typeof params.payload.error_message === 'string') {
    return 'postToolUseFailure'
  }
  if (typeof params.payload.status === 'string') {
    return 'stop'
  }
  if (typeof params.payload.session_id === 'string') {
    return 'sessionEnd'
  }
  return 'postToolUse'
}

function selectedRunnerPath(hooksDir: string): string | undefined {
  const runnerPath = path.join(
    hooksDir,
    process.platform === 'win32' ? 'belay-runner.ps1' : 'belay-runner',
  )
  const canonicalPath = canonicalExistingPath(runnerPath)
  if (!canonicalPath) {
    return undefined
  }
  try {
    if (!statSync(canonicalPath).isFile()) {
      return undefined
    }
    accessSync(canonicalPath, process.platform === 'win32' ? constants.R_OK : constants.X_OK)
    return canonicalPath
  } catch {
    return undefined
  }
}

function isRegularFile(filePath: string): boolean {
  const canonicalPath = canonicalExistingPath(filePath)
  if (!canonicalPath) {
    return false
  }
  try {
    return statSync(canonicalPath).isFile()
  } catch {
    return false
  }
}

function expectedHookArgs(kind: CursorHookKind, eventName: string): string[] {
  return kind === 'tool-gate' || kind === 'audit' ? [eventName] : []
}

function commandInvokesProjectHook(
  command: string,
  runnerPath: string,
  kind: CursorHookKind,
  eventName: string,
): boolean {
  const hookCommand = hookCommandFor(kind)
  const args = expectedHookArgs(kind, eventName)
  if (process.platform !== 'win32') {
    const expected = [`'${runnerPath.replaceAll("'", "'\\''")}'`, hookCommand, ...args].join(' ')
    return command === expected
  }
  const encoded = command.match(
    /^"[^"\r\n]+" -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand ([A-Za-z0-9+/=]+)$/,
  )?.[1]
  if (!encoded) {
    return false
  }
  const quotePowerShellLiteral = (value: string) => `'${value.replaceAll("'", "''")}'`
  const expected = [
    '&',
    quotePowerShellLiteral(runnerPath),
    ...[hookCommand, ...args].map(quotePowerShellLiteral),
  ].join(' ')
  return Buffer.from(encoded, 'base64').toString('utf16le') === expected
}

function expectedMatchers(
  eventName: string,
  payload: Record<string, unknown>,
): Array<string | undefined> {
  if (eventName === 'preToolUse') {
    // Managed preToolUse is intentionally unfiltered. Keep the legacy matcher variant so older
    // installed hooks still route through the same owner until upgrade.
    const values: Array<string | undefined> = [undefined]
    if (typeof payload.tool_name === 'string') {
      values.push(payload.tool_name)
    }
    return values
  }
  if (eventName === 'subagentStart') {
    return [typeof payload.subagent_type === 'string' ? payload.subagent_type : undefined]
  }
  return [undefined]
}

function hasManagedProjectHookEntry(
  repoRoot: string,
  runnerPath: string,
  params: RouteCursorHookParams,
): boolean {
  const eventName = eventNameFor(params)
  const matchers = new Set(expectedMatchers(eventName, params.payload))
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(cursorRoutingHooksSettingsPath(repoRoot), 'utf8'))
  } catch {
    return false
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return false
  }
  const hooks = (parsed as Record<string, unknown>).hooks
  if (hooks === null || typeof hooks !== 'object' || Array.isArray(hooks)) {
    return false
  }
  const entries = (hooks as Record<string, unknown>)[eventName]
  if (!Array.isArray(entries)) {
    return false
  }
  return entries.some((entry: unknown) => {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      return false
    }
    const definition = entry as Record<string, unknown>
    return (
      definition.failClosed === true &&
      matchers.has(definition.matcher as string | undefined) &&
      typeof definition.command === 'string' &&
      commandInvokesProjectHook(definition.command, runnerPath, params.kind, eventName)
    )
  })
}

function hasMatchingProjectShim(repoRoot: string, kind: CursorHookKind): boolean {
  let source: string
  try {
    source = readFileSync(path.join(cursorRoutingHooksDir(repoRoot), hookScriptFor(kind)), 'utf8')
  } catch {
    return false
  }
  return (
    source.includes("from '../belay/runtime/dispatcher.mjs'") &&
    source.includes(`origin: ${JSON.stringify({ scope: 'project', repoRoot })}`)
  )
}

function hasProjectOwnerInstallation(repoRoot: string): boolean {
  const hooksDir = cursorRoutingHooksDir(repoRoot)
  return Boolean(
    selectedRunnerPath(hooksDir) &&
      isRegularFile(path.join(cursorRoutingRuntimeDir(repoRoot), 'dispatcher.mjs')),
  )
}

function hasCallableProjectOwner(repoRoot: string, params: RouteCursorHookParams): boolean {
  const hooksDir = cursorRoutingHooksDir(repoRoot)
  const runnerPath = selectedRunnerPath(hooksDir)
  return Boolean(
    runnerPath &&
      isRegularFile(path.join(cursorRoutingRuntimeDir(repoRoot), 'dispatcher.mjs')) &&
      hasMatchingProjectShim(repoRoot, params.kind) &&
      hasManagedProjectHookEntry(repoRoot, runnerPath, params),
  )
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

function readInstallScope(repoRoot: string): RoutingInstallScope {
  const configPath = cursorRoutingConfigPath(repoRoot)
  let source: string
  try {
    source = readFileSync(configPath, 'utf8')
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'project'
  }
  try {
    const parsed: unknown = JSON.parse(source)
    if (
      parsed !== null &&
      typeof parsed === 'object' &&
      !Array.isArray(parsed) &&
      (parsed as Record<string, unknown>).installScope === 'global'
    ) {
      if (isTrustedCursorRoutingConfig(repoRoot, parsed)) {
        return 'global'
      }
      // Untrusted global scope still routes through the global owner when no project
      // installation exists. Otherwise a global-only workspace is blocked by the sentinel
      // even though ADR-008 assigns ownership to the User/global installation.
      return hasProjectOwnerInstallation(repoRoot) ? 'project' : 'global'
    }
  } catch {
    // A present config that cannot be read or parsed must retain Project ownership so the
    // selected Project hook reaches its fail-closed core path. Only a missing config is neutral.
  }
  return 'project'
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
  const repoRoot = canonicalExistingPath(findCursorRoutingRepoRoot(canonicalCwd))
  if (!repoRoot) {
    return { decision: 'neutral' }
  }
  const installScope = readInstallScope(repoRoot)
  if (installScope === 'missing') {
    return { decision: 'neutral' }
  }
  if (installScope === 'global') {
    return params.origin.scope === 'global'
      ? { decision: 'execute', repoRoot }
      : { decision: 'neutral' }
  }
  if (
    params.origin.scope === 'project' &&
    canonicalExistingPath(params.origin.repoRoot) !== repoRoot
  ) {
    return { decision: 'neutral' }
  }
  const callableProjectOwner = hasCallableProjectOwner(repoRoot, params)
  if (params.origin.scope === 'global') {
    return callableProjectOwner
      ? { decision: 'neutral' }
      : {
          decision: 'fail_closed',
          message:
            'belay project hook owner is unavailable; the global sentinel blocked this action.',
        }
  }
  const complete =
    callableProjectOwner && isRegularFile(path.join(cursorRoutingRuntimeDir(repoRoot), 'core.mjs'))
  return complete
    ? { decision: 'execute', repoRoot }
    : { decision: 'fail_closed', message: 'belay project hook installation is incomplete.' }
}
