import type { GatedAction } from '../gate-contract.js'
import type { ClassifyResult } from '../types.js'
import { BOUNDARY_PROFILE_L3_POLICY } from './boundary-profile.js'

export { BOUNDARY_PROFILE_L3_POLICY }
export const MAX_SHELL_COMMAND_BYTES = 64 * 1024
export const MAX_TOOL_PAYLOAD_BYTES = 1024 * 1024

function limitExceededResult(reason: 'input_too_large', summary: string): ClassifyResult {
  return {
    verdict: 'deny_pending_approval',
    reason,
    fingerprint: `limit:${reason}`,
    summary,
    assessment: {
      reversibility: 'irreversible',
      external: false,
      blastRadius: 'gate input budget',
      confidence: 1,
      signals: [reason, 'analysis_budget_exceeded'],
    },
    boundaryProfile: BOUNDARY_PROFILE_L3_POLICY,
  }
}

function shellCommandFromAction(action: GatedAction): string {
  if (action.command?.trim()) {
    return action.command.trim()
  }
  const payload = action.payload
  if (!payload) {
    return ''
  }
  const direct = payload.command
  if (typeof direct === 'string' && direct.trim()) {
    return direct.trim()
  }
  const toolInput = payload.tool_input
  if (toolInput && typeof toolInput === 'object') {
    const command = (toolInput as Record<string, unknown>).command
    if (typeof command === 'string' && command.trim()) {
      return command.trim()
    }
  }
  return ''
}

export function checkGatedActionLimits(action: GatedAction): ClassifyResult | null {
  if (action.kind === 'shell') {
    const command = shellCommandFromAction(action)
    if (Buffer.byteLength(command, 'utf8') > MAX_SHELL_COMMAND_BYTES) {
      return limitExceededResult('input_too_large', command.slice(0, 120))
    }
    return null
  }

  const payloadBytes = Buffer.byteLength(JSON.stringify(action.payload ?? {}), 'utf8')
  if (payloadBytes > MAX_TOOL_PAYLOAD_BYTES) {
    return limitExceededResult('input_too_large', action.toolName ?? action.kind)
  }
  return null
}
