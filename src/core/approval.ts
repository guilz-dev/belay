import { DEFAULT_APPROVAL_CONFIG } from './config.js'
import { buildReplayEnvelopeFields } from './approval-replay.js'
import type { ApprovalRecord, ApprovalStateFile } from './types.js'

/** @deprecated Use `DEFAULT_APPROVAL_CONFIG.executionLeaseMs` */
export const APPROVAL_EXECUTION_LEASE_MS = DEFAULT_APPROVAL_CONFIG.executionLeaseMs

export function nowIso(): string {
  return new Date().toISOString()
}

export function isExpired(approval: ApprovalRecord): boolean {
  return Date.parse(approval.expiresAt) <= Date.now()
}

export function isExecutionLeaseExpired(approval: ApprovalRecord): boolean {
  if (!approval.executionLeaseExpiresAt) {
    return false
  }
  return Date.parse(approval.executionLeaseExpiresAt) <= Date.now()
}

export function compactApprovals(state: ApprovalStateFile): ApprovalStateFile {
  return {
    version: state.version,
    approvals: state.approvals.filter(
      (approval) => !isExpired(approval) && !isExecutionLeaseExpired(approval),
    ),
  }
}

export function mergeApprovalStates(
  target: ApprovalStateFile,
  source: ApprovalStateFile,
): ApprovalStateFile {
  const byId = new Map<string, ApprovalRecord>()
  for (const approval of target.approvals) {
    byId.set(approval.approvalId, approval)
  }
  for (const approval of source.approvals) {
    if (!byId.has(approval.approvalId)) {
      byId.set(approval.approvalId, approval)
    }
  }
  return compactApprovals({
    version: target.version === 2 || source.version === 2 ? 2 : 1,
    approvals: [...byId.values()],
  })
}

export function escapeRegex(value: string): string {
  const specials = new Set(['.', '*', '+', '?', '^', '$', '{', '}', '(', ')', '|', '[', ']', '\\'])
  return [...value].map((char) => (specials.has(char) ? `\\${char}` : char)).join('')
}

export function approvalCommandMatch(prompt: string, tokenPrefix: string): string | null {
  const escapedPrefix = escapeRegex(tokenPrefix)
  const linePattern = new RegExp(`^\\s*${escapedPrefix}\\s+(\\S+)\\s*$`, 'i')
  for (const line of prompt.split(/\r?\n/)) {
    if (!line.trim()) {
      continue
    }
    const match = line.match(linePattern)
    return match?.[1] ?? null
  }
  return null
}

export function createApprovalRecordWithEnvelope(params: {
  kind: ApprovalRecord['kind']
  fingerprint: string
  repoRoot: string
  reason: string
  summary: string
  approvalTtlMinutes: number
  approvalId: string
  approvalInput?: {
    input: string
    inputKind: 'shell' | 'tool' | 'subagent'
    cwd?: string
    toolName?: string
    payload?: Record<string, unknown>
  }
}): ApprovalRecord {
  const envelope = buildReplayEnvelopeFields({
    kind: params.kind,
    command: params.approvalInput?.input,
    input: params.approvalInput?.input,
    inputKind: params.approvalInput?.inputKind,
    cwd: params.approvalInput?.cwd,
    toolName: params.approvalInput?.toolName,
    payload: params.approvalInput?.payload,
    fingerprint: params.fingerprint,
    repoRoot: params.repoRoot,
  })
  return createApprovalRecord({
    kind: params.kind,
    fingerprint: params.fingerprint,
    repoRoot: params.repoRoot,
    reason: params.reason,
    summary: params.summary,
    approvalTtlMinutes: params.approvalTtlMinutes,
    approvalId: params.approvalId,
    input: envelope.input ?? params.approvalInput?.input,
    inputKind: envelope.inputKind ?? params.approvalInput?.inputKind,
    cwd: envelope.cwd,
    toolName: envelope.toolName ?? params.approvalInput?.toolName,
    payloadHash: envelope.payloadHash,
    payloadJson: envelope.payloadJson,
  })
}

export function createApprovalRecord(params: {
  kind: ApprovalRecord['kind']
  fingerprint: string
  repoRoot: string
  reason: string
  summary: string
  approvalTtlMinutes: number
  approvalId: string
  input?: string
  inputKind?: 'shell' | 'tool' | 'subagent'
  cwd?: string
  toolName?: string
  payloadHash?: string
  payloadJson?: string
}): ApprovalRecord {
  const createdAt = nowIso()
  const expiresAt = new Date(Date.now() + params.approvalTtlMinutes * 60_000).toISOString()
  const record: ApprovalRecord = {
    approvalId: params.approvalId,
    kind: params.kind,
    fingerprint: params.fingerprint,
    repoRoot: params.repoRoot,
    reason: params.reason,
    summary: params.summary,
    createdAt,
    expiresAt,
  }
  if (params.input) {
    record.input = params.input
    record.inputKind = params.inputKind ?? (params.kind as 'shell' | 'tool' | 'subagent')
  }
  if (params.cwd) {
    record.cwd = params.cwd
  }
  if (params.toolName) {
    record.toolName = params.toolName
  }
  if (params.payloadHash) {
    record.payloadHash = params.payloadHash
  }
  if (params.payloadJson) {
    record.payloadJson = params.payloadJson
  }
  return record
}
