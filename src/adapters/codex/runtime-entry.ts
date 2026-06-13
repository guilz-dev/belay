import process from 'node:process'

import { codexLayout } from '../layouts/codex.js'
import type { GateRuntimeContext } from '../shared/gate-runtime.js'
import {
  appendObservedAudit,
  createDefaultGateRuntimeDeps,
  evaluateGatedAction,
  gateUnmappedToolVerdict,
  gateVerdictToCodexPreToolUseResponse,
  gateVerdictToCodexUserPromptResponse,
  processApprovalPrompt,
  resolveGateConfig,
} from '../shared/gate-runtime.js'
import { findRepoRoot } from '../shared/repo-root.js'

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

async function loadRuntimeContext(cwd: string): Promise<GateRuntimeContext> {
  const repoRoot = findRepoRoot(cwd, codexLayout)
  const configPath = codexLayout.configPath(repoRoot)
  const deps = createDefaultGateRuntimeDeps()
  const config = await resolveGateConfig({ layout: codexLayout, repoRoot, configPath }, deps)
  return { layout: codexLayout, repoRoot, config, configPath }
}

// shell is confirmed as tool_name:"Bash" / tool_input:{command} (TUI smoke, SPEC-v2.2 R-X1/R-X3).
// Non-shell names (apply_patch / read-family / subagent variants) are still best-guess pending
// the belay-adapter TUI smoke (G-B2). Unknown names ask with pending approval (R39).
function mapCodexToolName(toolName: string): 'shell' | 'subagent' | 'tool' | null {
  const name = toolName.toLowerCase()
  if (
    name === 'shell' ||
    name === 'bash' ||
    name === 'local_shell' ||
    name === 'exec_command' ||
    name === 'unified_exec'
  ) {
    return 'shell'
  }
  if (name === 'task' || name === 'spawn' || name === 'subagent') {
    return 'subagent'
  }
  if (
    name === 'read' ||
    name === 'grep' ||
    name === 'glob' ||
    name === 'ls' ||
    name === 'view' ||
    name === 'search' ||
    name === 'apply_patch' ||
    name === 'write' ||
    name === 'edit' ||
    name === 'multiedit' ||
    name === 'patch' ||
    name === 'delete' ||
    name === 'strreplace' ||
    name === 'str_replace'
  ) {
    return 'tool'
  }
  return null
}

function resolveCodexGateKind(
  eventName: string,
  toolName: string,
): 'shell' | 'subagent' | 'tool' | null {
  if (eventName === 'SubagentStart') {
    return 'subagent'
  }
  return mapCodexToolName(toolName)
}

function extractString(value: unknown, ...keys: string[]): string {
  if (!value || typeof value !== 'object') {
    return ''
  }
  const record = value as Record<string, unknown>
  for (const key of keys) {
    if (typeof record[key] === 'string') {
      return record[key] as string
    }
  }
  return ''
}

function normalizeCodexToolPayload(
  kind: 'shell' | 'subagent' | 'tool',
  payload: Record<string, unknown>,
): Record<string, unknown> {
  const toolInput = payload.tool_input
  if (kind === 'shell') {
    return {
      tool_name: 'Shell',
      tool_input: { command: extractString(toolInput, 'command', 'cmd') },
    }
  }
  if (kind === 'tool') {
    const toolName = String(payload.tool_name ?? payload.toolName ?? '')
    const lowered = toolName.toLowerCase()
    if (lowered === 'write') {
      return {
        tool_name: 'Write',
        tool_input: {
          path: extractString(toolInput, 'path', 'file_path', 'filename'),
        },
      }
    }
    if (lowered === 'delete') {
      return {
        tool_name: 'Delete',
        tool_input: {
          path: extractString(toolInput, 'path', 'file_path', 'filename'),
        },
      }
    }
    if (
      lowered === 'edit' ||
      lowered === 'multiedit' ||
      lowered === 'patch' ||
      lowered === 'strreplace' ||
      lowered === 'str_replace'
    ) {
      return {
        tool_name: 'StrReplace',
        tool_input: {
          path: extractString(toolInput, 'path', 'file_path', 'filename'),
        },
      }
    }
    if (lowered === 'apply_patch') {
      return {
        tool_name: 'ApplyPatch',
        tool_input: {
          patch: extractString(toolInput, 'patch', 'input', 'text'),
        },
      }
    }
    return {
      tool_name: toolName,
      tool_input: typeof toolInput === 'object' && toolInput ? toolInput : {},
    }
  }
  return payload
}

export async function runBeforeSubmitPromptHook() {
  try {
    const payload = await readStdinJson()
    const prompt = String(payload.prompt ?? payload.user_message ?? '')
    const ctx = await loadRuntimeContext(process.cwd())
    const deps = createDefaultGateRuntimeDeps()
    const result = await processApprovalPrompt(ctx, deps, prompt)
    jsonResponse(gateVerdictToCodexUserPromptResponse(result))
  } catch {
    jsonResponse({
      decision: 'block',
      reason:
        'agent-belay failed while processing approval state. Run agent-belay doctor, then retry.',
    })
  }
}

// Codex routes all PreToolUse through this unified handler (matcher ".*"), since the exact
// shell tool name is not yet confirmed. SubagentStart is also routed to this handler.
// Unmapped tools/events ask with pending approval (R39) to avoid silent bypass without hard block.
export async function runToolGateHook(eventName: string) {
  try {
    const payload = await readStdinJson()
    const cwd = process.cwd()
    const toolName = String(payload.tool_name ?? payload.toolName ?? '')
    const kind = resolveCodexGateKind(eventName, toolName)
    const ctx = await loadRuntimeContext(cwd)
    const deps = createDefaultGateRuntimeDeps()
    if (!kind) {
      // Unmapped Codex tool. Policy-driven: default 'deny' asks with pending approval (R39).
      // 'allow' is the opt-out — pass the tool but record it to audit for vocabulary learning.
      const policy = ctx.config.policy?.codexUnmappedTool ?? 'deny'
      if (policy === 'allow') {
        await appendObservedAudit(ctx, deps, eventName, payload)
        jsonResponse({})
        return
      }
      const verdict = await gateUnmappedToolVerdict(ctx, deps, toolName, payload)
      jsonResponse(gateVerdictToCodexPreToolUseResponse(verdict))
      return
    }
    const normalizedPayload = normalizeCodexToolPayload(kind, payload)
    const verdict = await evaluateGatedAction(ctx, deps, {
      kind,
      cwd,
      command:
        kind === 'shell' ? extractString(normalizedPayload.tool_input, 'command') : undefined,
      payload: normalizedPayload,
      toolName,
    })
    jsonResponse(gateVerdictToCodexPreToolUseResponse(verdict))
  } catch {
    // Fail-closed: deny on classifier failure (belay is a floor).
    jsonResponse({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason:
          'agent-belay failed while classifying this tool action. Run agent-belay doctor, then retry.',
      },
    })
  }
}

// Provided for symmetry with the shared templates; not wired by default (Codex routes shell
// through the unified PreToolUse handler above).
export async function runShellGateHook() {
  try {
    const payload = await readStdinJson()
    const command = extractString(payload.tool_input, 'command') || String(payload.command ?? '')
    const cwd = process.cwd()
    const ctx = await loadRuntimeContext(cwd)
    const deps = createDefaultGateRuntimeDeps()
    const verdict = await evaluateGatedAction(ctx, deps, {
      kind: 'shell',
      cwd,
      command,
      payload,
      toolName: 'Shell',
    })
    jsonResponse(gateVerdictToCodexPreToolUseResponse(verdict))
  } catch {
    jsonResponse({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason:
          'agent-belay failed while classifying this shell command. Run agent-belay doctor, then retry.',
      },
    })
  }
}

export async function runAuditHook(eventName: string) {
  try {
    const payload = await readStdinJson()
    const ctx = await loadRuntimeContext(process.cwd())
    const deps = createDefaultGateRuntimeDeps()
    await appendObservedAudit(ctx, deps, eventName, payload)
    jsonResponse({})
  } catch (error) {
    console.error(
      'agent-belay audit hook failed:',
      error instanceof Error ? error.message : String(error),
    )
    jsonResponse({})
  }
}
