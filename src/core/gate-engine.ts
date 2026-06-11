import { classifyShell } from './classify-shell.js'
import { classifySubagent } from './classify-subagent.js'
import { classifyToolUse } from './classify-tool.js'
import type { BelayConfigV3 } from './config.js'
import { classifierOptionsFromConfig } from './config.js'
import type { GatedAction, GatedActionKind } from './gate-contract.js'
import { GATE_CONTRACT_VERSION } from './gate-contract.js'
import type { ClassifyResult } from './types.js'

export class GateNormalizationError extends Error {
  readonly reason = 'normalization_failed'

  constructor(message: string) {
    super(message)
    this.name = 'GateNormalizationError'
  }
}

function shellCommandFromPayload(payload: Record<string, unknown>): string {
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

export function normalizeGatedAction(params: {
  kind: GatedActionKind
  repoRoot: string
  cwd: string
  command?: string
  payload?: Record<string, unknown>
  toolName?: string
  agentAssessment?: GatedAction['agentAssessment']
}): GatedAction {
  const { kind, repoRoot, cwd, payload, toolName, agentAssessment } = params
  let command = params.command?.trim() ?? ''

  if (kind === 'shell' && !command && payload) {
    command = shellCommandFromPayload(payload)
  }

  if (kind === 'shell' && !command) {
    throw new GateNormalizationError('Shell gated action requires a command.')
  }

  if (kind === 'tool' && !payload) {
    throw new GateNormalizationError('Tool gated action requires a payload.')
  }

  if (kind === 'subagent' && !payload) {
    throw new GateNormalizationError('Subagent gated action requires a payload.')
  }

  return {
    contractVersion: GATE_CONTRACT_VERSION,
    kind,
    repoRoot,
    cwd,
    command: command || undefined,
    payload,
    toolName,
    agentAssessment,
  }
}

export function classifyGatedAction(action: GatedAction, config: BelayConfigV3): ClassifyResult {
  const options = classifierOptionsFromConfig(config)

  if (action.kind === 'shell') {
    const command = action.command ?? shellCommandFromPayload(action.payload ?? {})
    if (!command) {
      throw new GateNormalizationError('Shell gated action requires a command.')
    }
    return classifyShell(command, action.cwd, action.repoRoot, options)
  }

  if (action.kind === 'subagent') {
    return classifySubagent(action.payload ?? {}, action.repoRoot, options)
  }

  return classifyToolUse(action.payload ?? {}, action.repoRoot, action.cwd, options)
}

export function gateEnabledForAction(config: BelayConfigV3, action: GatedAction): boolean {
  if (action.kind === 'shell') {
    return config.gates.shell
  }
  if (action.kind === 'subagent') {
    return config.gates.subagent
  }

  const toolName = action.toolName ?? String(action.payload?.tool_name ?? '')
  if (toolName === 'Shell') {
    return config.gates.toolShell
  }
  if (toolName === 'Write' || toolName === 'StrReplace' || toolName === 'Delete') {
    return config.gates.fileMutation
  }
  if (toolName === 'Task') {
    return config.gates.subagent
  }
  return true
}
