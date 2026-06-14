import type { ApprovalRecord, ApprovalStateFile } from './types.js'

/** Cursor may invoke the same shell gate more than once per retry; lease covers that window. */
export const APPROVAL_EXECUTION_LEASE_MS = 60_000

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

export function buildRetryInstruction(tokenPrefix: string, approvalId: string): string {
  return `To allow the next matching action once, send ${tokenPrefix} ${approvalId} and then retry the original action unchanged.`
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
  return record
}
