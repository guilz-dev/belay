import path from 'node:path'
import process from 'node:process'

import { approvalCommandMatch } from '../../core/approval.js'
import {
  findApprovalRepoRoots,
  formatAmbiguousApprovalRepoMessage,
} from '../../core/approval-repo-lookup.js'
import { DEFAULT_CONFIG_V4 } from '../../core/config.js'
import { cursorLayout } from '../layouts/cursor.js'
import type { GateRuntimeContext } from '../shared/gate-runtime.js'
import {
  appendObservedAudit,
  createDefaultGateRuntimeDeps,
  evaluateGatedAction,
  gateVerdictToCursorResponse,
  processApprovalPrompt,
  resolveGateConfig,
} from '../shared/gate-runtime.js'
import { findRepoRoot } from '../shared/repo-root.js'
import {
  type CursorActionCwdResolution,
  GLOBAL_HOOK_WORKSPACE_MISSING_MESSAGE,
  isUnsafeGlobalHookFallback,
  resolveCursorActionCwdDetails,
} from './cwd-resolution.js'

async function readStdinJson(): Promise<Record<string, unknown>> {
  const chunks: string[] = []
  for await (const chunk of process.stdin) {
    chunks.push(typeof chunk === 'string' ? chunk : chunk.toString('utf8'))
  }
  const raw = chunks.join('').trim()
  if (!raw) {
    return {}
  }
  try {
    return JSON.parse(raw) as Record<string, unknown>
  } catch {
    return {}
  }
}

function jsonResponse(value: unknown) {
  process.stdout.write(`${JSON.stringify(value)}\n`)
}

export function resolveCursorActionCwd(
  payload: Record<string, unknown>,
  fallback: string = process.cwd(),
): string {
  return resolveCursorActionCwdDetails(payload, fallback).cwd
}

function resolveCursorToolActionCwdDetails(
  payload: Record<string, unknown>,
  fallback: string,
  eventName: string,
  toolName: string,
): CursorActionCwdResolution {
  if ((eventName === 'preToolUse' || eventName === 'PreToolUse') && toolName === 'Shell') {
    return resolveCursorActionCwdDetails(payload, fallback)
  }

  const toolInput = payload.tool_input
  if (toolInput === null || typeof toolInput !== 'object' || Array.isArray(toolInput)) {
    return resolveCursorActionCwdDetails(payload, fallback)
  }
  const { working_directory: _workingDirectory, ...withoutWorkingDirectory } = toolInput as Record<
    string,
    unknown
  >
  return resolveCursorActionCwdDetails(
    { ...payload, tool_input: withoutWorkingDirectory },
    fallback,
  )
}

function collectCandidateRepoRoots(
  payload: Record<string, unknown>,
  resolution: CursorActionCwdResolution,
): string[] {
  const roots: string[] = []
  const add = (value: string) => {
    const resolved = path.resolve(value)
    if (!roots.includes(resolved)) {
      roots.push(resolved)
    }
  }
  if (Array.isArray(payload.workspace_roots)) {
    for (const root of payload.workspace_roots) {
      if (typeof root === 'string' && root.trim()) {
        add(root)
      }
    }
  }
  add(resolution.cwd)
  return roots
}

async function loadRuntimeContext(cwd: string): Promise<GateRuntimeContext> {
  const repoRoot = findRepoRoot(cwd, cursorLayout)
  const configPath = cursorLayout.configPath(repoRoot)
  const deps = createDefaultGateRuntimeDeps()
  const config = await resolveGateConfig({ layout: cursorLayout, repoRoot, configPath }, deps)
  return { layout: cursorLayout, repoRoot, config, configPath }
}

async function processApprovalPromptWithRepoFallback(
  ctx: GateRuntimeContext,
  deps: ReturnType<typeof createDefaultGateRuntimeDeps>,
  prompt: string,
  payload: Record<string, unknown>,
  resolution: CursorActionCwdResolution,
): Promise<Awaited<ReturnType<typeof processApprovalPrompt>>> {
  const tokenPrefix = ctx.config.tokenPrefix || DEFAULT_CONFIG_V4.tokenPrefix
  const approvalId = approvalCommandMatch(prompt, tokenPrefix)
  const result = await processApprovalPrompt(ctx, deps, prompt)

  if (result.continue || !approvalId) {
    return result
  }

  const notFound =
    result.user_message?.includes('not found') ||
    result.user_message?.includes('Belay approval not found')
  if (!notFound) {
    return result
  }

  const candidates = collectCandidateRepoRoots(payload, resolution).filter(
    (root) => root !== ctx.repoRoot,
  )
  if (candidates.length === 0) {
    return result
  }

  const lookup = await findApprovalRepoRoots({
    approvalId,
    candidateRepoRoots: candidates,
    adapter: 'cursor',
  })

  if (lookup.status === 'ambiguous') {
    return {
      continue: false,
      user_message: formatAmbiguousApprovalRepoMessage(lookup.repoRoots),
    }
  }
  if (lookup.status !== 'found') {
    return result
  }

  const retryCtx = await loadRuntimeContext(lookup.repoRoot)
  return processApprovalPrompt(retryCtx, deps, prompt)
}

function isSubagentEvent(payload: Record<string, unknown>, eventName: string): boolean {
  return eventName === 'subagentStart' || payload.subagent_type !== undefined
}

function isFileMutationTool(toolName: string): boolean {
  return toolName === 'Write' || toolName === 'StrReplace' || toolName === 'Delete'
}

export async function runBeforeSubmitPromptHook() {
  try {
    const payload = await readStdinJson()
    const prompt = String(payload.prompt ?? '')
    const resolution = resolveCursorActionCwdDetails(payload)

    if (isUnsafeGlobalHookFallback(resolution)) {
      jsonResponse({
        continue: false,
        user_message: GLOBAL_HOOK_WORKSPACE_MISSING_MESSAGE,
      })
      return
    }

    const ctx = await loadRuntimeContext(resolution.cwd)
    const deps = createDefaultGateRuntimeDeps()
    const result = await processApprovalPromptWithRepoFallback(
      ctx,
      deps,
      prompt,
      payload,
      resolution,
    )
    jsonResponse({
      continue: result.continue,
      ...(result.user_message ? { user_message: result.user_message } : {}),
      ...(result.replay ? { replay: result.replay } : {}),
    })
  } catch {
    jsonResponse({
      continue: false,
      user_message: 'belay failed while processing approval state. Run belay doctor, then retry.',
    })
  }
}

export async function runShellGateHook() {
  try {
    const payload = await readStdinJson()
    const command = String(payload.command ?? '').trim()
    const resolution = resolveCursorActionCwdDetails(payload)

    if (isUnsafeGlobalHookFallback(resolution)) {
      jsonResponse({
        permission: 'deny',
        user_message: GLOBAL_HOOK_WORKSPACE_MISSING_MESSAGE,
      })
      return
    }

    const cwd = resolution.cwd
    const ctx = await loadRuntimeContext(cwd)
    const deps = createDefaultGateRuntimeDeps()
    const verdict = await evaluateGatedAction(ctx, deps, {
      kind: 'shell',
      cwd,
      command,
      payload,
      sourceEvent: 'beforeShellExecution',
    })
    jsonResponse(gateVerdictToCursorResponse(verdict))
  } catch {
    jsonResponse({
      permission: 'deny',
      user_message:
        'belay failed while classifying this shell command. Run belay doctor, then retry.',
    })
  }
}

export async function runToolGateHook(eventName: string) {
  try {
    const payload = await readStdinJson()
    const toolName = String(payload.tool_name ?? '')
    const resolution = resolveCursorToolActionCwdDetails(
      payload,
      process.cwd(),
      eventName,
      toolName,
    )

    if (isUnsafeGlobalHookFallback(resolution)) {
      jsonResponse({
        permission: 'deny',
        user_message: GLOBAL_HOOK_WORKSPACE_MISSING_MESSAGE,
      })
      return
    }

    const cwd = resolution.cwd
    const ctx = await loadRuntimeContext(cwd)
    const deps = createDefaultGateRuntimeDeps()

    if (isSubagentEvent(payload, eventName)) {
      const verdict = await evaluateGatedAction(ctx, deps, {
        kind: 'subagent',
        cwd,
        payload,
        sourceEvent: eventName,
      })
      jsonResponse(gateVerdictToCursorResponse(verdict))
      return
    }

    if (toolName === 'Shell') {
      const verdict = await evaluateGatedAction(ctx, deps, {
        kind: 'shell',
        cwd,
        payload,
        toolName,
        sourceEvent: eventName,
      })
      jsonResponse(gateVerdictToCursorResponse(verdict))
      return
    }

    if (isFileMutationTool(toolName)) {
      const verdict = await evaluateGatedAction(ctx, deps, {
        kind: 'tool',
        cwd,
        payload,
        toolName,
        sourceEvent: eventName,
      })
      jsonResponse(gateVerdictToCursorResponse(verdict))
      return
    }

    if (payload.tool_name === 'Task') {
      const verdict = await evaluateGatedAction(ctx, deps, {
        kind: 'subagent',
        cwd,
        payload,
        sourceEvent: eventName,
      })
      jsonResponse(gateVerdictToCursorResponse(verdict))
      return
    }

    jsonResponse({ permission: 'allow' })
  } catch {
    jsonResponse({
      permission: 'deny',
      user_message:
        'belay failed while classifying this tool action. Run belay doctor, then retry.',
    })
  }
}

export async function runAuditHook(eventName: string) {
  try {
    const payload = await readStdinJson()
    const toolName = String(payload.tool_name ?? '')
    const resolution = resolveCursorToolActionCwdDetails(
      payload,
      process.cwd(),
      eventName,
      toolName,
    )

    if (isUnsafeGlobalHookFallback(resolution)) {
      jsonResponse({})
      return
    }

    const ctx = await loadRuntimeContext(resolution.cwd)
    const deps = createDefaultGateRuntimeDeps()
    await appendObservedAudit(ctx, deps, eventName, payload)
    jsonResponse({})
  } catch (error) {
    console.error(
      'belay audit hook failed:',
      error instanceof Error ? error.message : String(error),
    )
    jsonResponse({})
  }
}
