import type { Assessment, ClassifyResult, HookVerdict } from './types.js'

export const GATE_CONTRACT_VERSION = 1 as const

export type GatedActionKind = 'shell' | 'subagent' | 'tool'

export interface GatedAction {
  contractVersion: typeof GATE_CONTRACT_VERSION
  kind: GatedActionKind
  repoRoot: string
  cwd: string
  command?: string
  payload?: Record<string, unknown>
  toolName?: string
  /** Reserved for v0.5 agent-side assessment ingestion. */
  agentAssessment?: Assessment
}

export interface GatePermissionResponse {
  permission: 'allow' | 'deny'
  user_message?: string
  agent_message?: string
}

export interface GateVerdict extends GatePermissionResponse {
  contractVersion: typeof GATE_CONTRACT_VERSION
  verdict: HookVerdict
  reason: string
  fingerprint: string
  assessment: Assessment
  normalizedCommand?: string
  summary?: string
  approvalId?: string
  wouldBlock: boolean
  mode: 'enforce' | 'audit'
  axes?: ClassifyResult['axes']
}

export function isGatedAction(value: unknown): value is GatedAction {
  if (typeof value !== 'object' || value === null) {
    return false
  }
  const record = value as GatedAction
  return (
    record.contractVersion === GATE_CONTRACT_VERSION &&
    (record.kind === 'shell' || record.kind === 'subagent' || record.kind === 'tool') &&
    typeof record.repoRoot === 'string' &&
    typeof record.cwd === 'string'
  )
}

export function classifyResultToGateVerdict(params: {
  result: ClassifyResult
  mode: 'enforce' | 'audit'
  permission: 'allow' | 'deny'
  wouldBlock: boolean
  approvalId?: string
  user_message?: string
  agent_message?: string
}): GateVerdict {
  const { result, mode, permission, wouldBlock, approvalId, user_message, agent_message } = params
  return {
    contractVersion: GATE_CONTRACT_VERSION,
    verdict: result.verdict,
    reason: result.reason,
    fingerprint: result.fingerprint,
    assessment: result.assessment,
    normalizedCommand: result.normalizedCommand,
    summary: result.summary,
    permission,
    wouldBlock,
    mode,
    approvalId,
    user_message,
    agent_message,
    axes: result.axes,
  }
}

export function unnormalizedGateVerdict(params: {
  reason: string
  mode: 'enforce' | 'audit'
  user_message: string
  agent_message?: string
}): GateVerdict {
  return {
    contractVersion: GATE_CONTRACT_VERSION,
    verdict: 'deny_pending_approval',
    reason: params.reason,
    fingerprint: 'unnormalized',
    assessment: {
      reversibility: 'irreversible',
      external: true,
      blastRadius: 'unknown',
      confidence: 0,
      signals: ['normalization_failed'],
    },
    permission: 'deny',
    wouldBlock: true,
    mode: params.mode,
    user_message: params.user_message,
    agent_message: params.agent_message,
  }
}
