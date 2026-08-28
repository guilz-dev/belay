import type { GatedActionKind } from './gate-contract.js'
import { scrubValue } from './scrub.js'
import type { ScrubOptions } from './types.js'

export function redactToolInvocationId(value: unknown, rawToolUseId?: string): unknown {
  if (typeof value === 'string') {
    return rawToolUseId ? value.replaceAll(rawToolUseId, '<tool-use-id>') : value
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactToolInvocationId(item, rawToolUseId))
  }
  if (value && typeof value === 'object') {
    const result: Record<string, unknown> = {}
    for (const [key, child] of Object.entries(value)) {
      if (key !== 'tool_use_id') {
        result[key] = redactToolInvocationId(child, rawToolUseId)
      }
    }
    return result
  }
  return value
}

/** Subagent fingerprint input — must match classify-subagent `fingerprintSource`. */
export function subagentFingerprintSource(
  payload: Record<string, unknown>,
  scrubOptions: ScrubOptions,
): unknown {
  const toolInput = payload.tool_input
  if (toolInput && typeof toolInput === 'object') {
    const input = toolInput as Record<string, unknown>
    return scrubValue(
      {
        description: input.description ?? '',
        prompt: input.prompt ?? '',
      },
      scrubOptions,
    )
  }
  const task = payload.task
  if (typeof task === 'string') {
    return scrubValue({ task }, scrubOptions)
  }
  if (task && typeof task === 'object') {
    const taskObj = task as Record<string, unknown>
    return scrubValue(
      {
        description: taskObj.description ?? '',
        prompt: taskObj.prompt ?? '',
      },
      scrubOptions,
    )
  }
  return scrubValue(payload, scrubOptions)
}

/**
 * Scrubbed payload used for replay envelope hashing — aligned with classifier fingerprints.
 * Tool: scrubbed `tool_input`. Subagent: description/prompt subset. Other: full payload.
 */
export function fingerprintReplayPayload(
  kind: GatedActionKind,
  payload: Record<string, unknown> | undefined,
  scrubOptions: ScrubOptions,
): Record<string, unknown> | undefined {
  if (!payload) {
    return undefined
  }
  const replayPayload = redactToolInvocationId(
    payload,
    typeof payload.tool_use_id === 'string' ? payload.tool_use_id : undefined,
  ) as Record<string, unknown>
  if (kind === 'tool') {
    const toolInput = replayPayload.tool_input
    if (toolInput && typeof toolInput === 'object') {
      return scrubValue(toolInput, scrubOptions) as Record<string, unknown>
    }
  }
  if (kind === 'subagent') {
    return subagentFingerprintSource(replayPayload, scrubOptions) as Record<string, unknown>
  }
  return scrubValue(replayPayload, scrubOptions) as Record<string, unknown>
}
