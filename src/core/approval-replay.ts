import path from 'node:path'

import type { ApprovalFlow, BelayConfigV4 } from './config.js'
import { canonicalStringify, hashValue } from './fingerprint.js'
import type { ApprovalRecord } from './types.js'

export type { ApprovalFlow } from './config.js'
export type ReplayAdapterId = 'cursor' | 'claude' | 'codex'

export { DEFAULT_CLI_REPLAY_TIMEOUT_MS, replayShellCommand } from './approval-replay-cli.js'

export interface ApprovalReplayHint {
  kind: 'shell' | 'tool' | 'subagent'
  input: string
  cwd?: string
  toolName?: string
  fingerprint: string
  approvalId: string
  autoReplay: boolean
  fallbackToTwoStep: boolean
}

export interface ReplayEnvelopeInput {
  kind: ApprovalRecord['kind']
  cwd?: string
  toolName?: string
  command?: string
  input?: string
  inputKind?: 'shell' | 'tool' | 'subagent'
  payload?: Record<string, unknown>
  fingerprint: string
  repoRoot: string
}

export interface ReplayActionContext {
  kind: ApprovalRecord['kind']
  cwd?: string
  toolName?: string
  command?: string
  payload?: Record<string, unknown>
  fingerprint: string
  repoRoot: string
}

const MAX_PAYLOAD_JSON_BYTES = 16_384

export function replayPayloadHash(
  kind: ApprovalRecord['kind'],
  payload: Record<string, unknown> | undefined,
  repoRoot: string,
): string | undefined {
  if (!payload || Object.keys(payload).length === 0) {
    return undefined
  }
  const json = canonicalStringify(payload)
  return hashValue(`payload:${kind}:${json}:${repoRoot}`)
}

const DEFAULT_REPLAY_CAPABILITIES = {
  shell: true,
  tool: false,
  subagent: false,
} as const

const ADAPTER_REPLAY_CAPABLE: Record<
  ReplayAdapterId,
  { shell: boolean; tool: boolean; subagent: boolean }
> = {
  cursor: { ...DEFAULT_REPLAY_CAPABILITIES },
  claude: { ...DEFAULT_REPLAY_CAPABILITIES },
  codex: { ...DEFAULT_REPLAY_CAPABILITIES },
}

export function getExecutionLeaseMs(config: BelayConfigV4): number {
  const ms = config.approval?.executionLeaseMs
  return typeof ms === 'number' && ms > 0 ? ms : 60_000
}

export function approvalFlow(config: BelayConfigV4): ApprovalFlow {
  return config.approval?.flow === 'two_step' ? 'two_step' : 'one_step'
}

export function buildReplayEnvelopeFields(input: ReplayEnvelopeInput): Partial<ApprovalRecord> {
  const fields: Partial<ApprovalRecord> = {}
  const cmd = input.command ?? input.input ?? ''
  if (cmd) {
    fields.input = cmd
    fields.inputKind = input.inputKind ?? (input.kind as 'shell' | 'tool' | 'subagent')
  }
  if (input.cwd) {
    fields.cwd = path.resolve(input.cwd)
  }
  if (input.toolName) {
    fields.toolName = input.toolName
  }
  if (input.payload && Object.keys(input.payload).length > 0) {
    const json = canonicalStringify(input.payload)
    if (Buffer.byteLength(json, 'utf8') <= MAX_PAYLOAD_JSON_BYTES) {
      fields.payloadJson = json
    }
    fields.payloadHash = replayPayloadHash(input.kind, input.payload, input.repoRoot)
  }
  return fields
}

export function hasReplayEnvelope(approval: ApprovalRecord): boolean {
  return Boolean(approval.cwd || approval.toolName || approval.payloadHash)
}

export function validateReplayEnvelope(
  approval: ApprovalRecord,
  action: ReplayActionContext,
): boolean {
  if (!hasReplayEnvelope(approval)) {
    return true
  }
  if (approval.kind !== action.kind) {
    return false
  }
  if (approval.fingerprint !== action.fingerprint) {
    return false
  }
  if (approval.repoRoot !== action.repoRoot) {
    return false
  }
  if (approval.cwd && path.resolve(approval.cwd) !== path.resolve(action.cwd ?? '')) {
    return false
  }
  if (approval.toolName && approval.toolName !== action.toolName) {
    return false
  }
  if (approval.payloadHash) {
    const hash = replayPayloadHash(action.kind, action.payload, action.repoRoot)
    if (!hash || approval.payloadHash !== hash) {
      return false
    }
  }
  return true
}

export function canAutoReplay(
  config: BelayConfigV4,
  kind: ApprovalRecord['kind'],
  adapter?: ReplayAdapterId,
): boolean {
  if (config.approvalSigning?.required) {
    return false
  }
  if (approvalFlow(config) !== 'one_step') {
    return false
  }
  if (kind !== 'shell' && kind !== 'tool' && kind !== 'subagent') {
    return false
  }
  const scopes = config.approval?.autoReplayScopes
  if (kind === 'shell' && scopes?.shell === false) {
    return false
  }
  if (kind === 'tool' && scopes?.tool !== true) {
    return false
  }
  if (kind === 'subagent' && scopes?.subagent !== true) {
    return false
  }
  if (adapter) {
    return ADAPTER_REPLAY_CAPABLE[adapter][kind] === true
  }
  return kind === 'shell' && scopes?.shell !== false
}

export function buildRetryInstructionForConfig(
  config: BelayConfigV4,
  tokenPrefix: string,
  approvalId: string,
): string {
  if (approvalFlow(config) === 'one_step') {
    return `To allow this action once, send ${tokenPrefix} ${approvalId}. After approval, retry the same action unchanged.`
  }
  return `To allow the next matching action once, send ${tokenPrefix} ${approvalId} and then retry the original action unchanged.`
}

export function buildApprovalRecordedMessage(
  config: BelayConfigV4,
  approval: ApprovalRecord,
  adapter?: ReplayAdapterId,
): string {
  if (!canAutoReplay(config, approval.kind, adapter)) {
    return `Belay approval recorded for ${approval.approvalId}. Retry the original action once before it expires.`
  }
  if (approval.kind === 'shell' && approval.input) {
    return (
      `Belay approval recorded for ${approval.approvalId}. ` +
      `Retry this shell command unchanged: ${approval.input}`
    )
  }
  return `Belay approval recorded for ${approval.approvalId}. Retry the original action once before it expires.`
}

export function buildReplayHint(
  config: BelayConfigV4,
  approval: ApprovalRecord,
  adapter?: ReplayAdapterId,
): ApprovalReplayHint | null {
  if (approvalFlow(config) !== 'one_step') {
    return null
  }
  const input = approval.input ?? approval.summary
  if (!input) {
    return null
  }
  const autoReplay = canAutoReplay(config, approval.kind, adapter)
  return {
    kind: approval.kind as 'shell' | 'tool' | 'subagent',
    input,
    cwd: approval.cwd,
    toolName: approval.toolName,
    fingerprint: approval.fingerprint,
    approvalId: approval.approvalId,
    autoReplay,
    fallbackToTwoStep: !autoReplay,
  }
}
