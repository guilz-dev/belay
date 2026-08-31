import process from 'node:process'

import { type CursorHookKind, type CursorHookOrigin, routeCursorHook } from './hook-router.js'

export interface DispatchCursorHookParams {
  origin: CursorHookOrigin
  kind: CursorHookKind
  eventName: string
}

type CursorResponse = Record<string, unknown>

interface CursorCoreHandlers {
  handleBeforeSubmitPromptHook(payload: Record<string, unknown>): Promise<CursorResponse>
  handleShellGateHook(payload: Record<string, unknown>): Promise<CursorResponse>
  handleToolGateHook(eventName: string, payload: Record<string, unknown>): Promise<CursorResponse>
  handleAuditHook(eventName: string, payload: Record<string, unknown>): Promise<CursorResponse>
}

async function readStdinPayload(): Promise<
  { ok: true; payload: Record<string, unknown> } | { ok: false }
> {
  const chunks: string[] = []
  for await (const chunk of process.stdin) {
    chunks.push(typeof chunk === 'string' ? chunk : chunk.toString('utf8'))
  }
  const raw = chunks.join('').trim()
  if (!raw) {
    return { ok: false }
  }
  try {
    const parsed: unknown = JSON.parse(raw)
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? { ok: true, payload: parsed as Record<string, unknown> }
      : { ok: false }
  } catch {
    return { ok: false }
  }
}

function neutralResponse(kind: CursorHookKind): CursorResponse {
  if (kind === 'before-submit') {
    return { continue: true }
  }
  if (kind === 'audit') {
    return {}
  }
  return { permission: 'allow' }
}

function failClosedResponse(kind: CursorHookKind, message: string): CursorResponse {
  if (kind === 'audit') {
    console.error(`belay audit hook skipped: ${message}`)
    return {}
  }
  if (kind === 'before-submit') {
    return { continue: false, user_message: message }
  }
  return { permission: 'deny', user_message: message }
}

async function executeCoreHandler(
  params: DispatchCursorHookParams,
  payload: Record<string, unknown>,
): Promise<CursorResponse> {
  const coreModulePath = './core.mjs'
  const core = (await import(coreModulePath)) as CursorCoreHandlers
  if (params.kind === 'before-submit') {
    return core.handleBeforeSubmitPromptHook(payload)
  }
  if (params.kind === 'shell-gate') {
    return core.handleShellGateHook(payload)
  }
  if (params.kind === 'tool-gate') {
    return core.handleToolGateHook(params.eventName, payload)
  }
  return core.handleAuditHook(params.eventName, payload)
}

async function dispatchCursorHookResponse(
  params: DispatchCursorHookParams,
): Promise<CursorResponse> {
  const input = await readStdinPayload()
  if (!input.ok) {
    return failClosedResponse(params.kind, 'belay received malformed Cursor hook input.')
  }

  try {
    const route = routeCursorHook({
      origin: params.origin,
      kind: params.kind,
      payload: input.payload,
    })
    if (route.decision === 'neutral') {
      return neutralResponse(params.kind)
    }
    if (route.decision === 'fail_closed') {
      return failClosedResponse(params.kind, route.message)
    }
    return await executeCoreHandler(params, input.payload)
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    return failClosedResponse(
      params.kind,
      `belay failed while dispatching this Cursor hook: ${detail}`,
    )
  }
}

export async function dispatchCursorHook(params: DispatchCursorHookParams): Promise<void> {
  const response = await dispatchCursorHookResponse(params)
  process.stdout.write(`${JSON.stringify(response)}\n`)
}
