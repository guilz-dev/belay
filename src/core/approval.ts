import type { ApprovalRecord, ApprovalStateFile } from './types.js'

export function nowIso(): string {
  return new Date().toISOString()
}

export function isExpired(approval: ApprovalRecord): boolean {
  return Date.parse(approval.expiresAt) <= Date.now()
}

export function compactApprovals(state: ApprovalStateFile): ApprovalStateFile {
  return {
    version: 1,
    approvals: state.approvals.filter((approval) => !isExpired(approval)),
  }
}

export function escapeRegex(value: string): string {
  const specials = new Set(['.', '*', '+', '?', '^', '$', '{', '}', '(', ')', '|', '[', ']', '\\'])
  return [...value].map((char) => (specials.has(char) ? `\\${char}` : char)).join('')
}

export function approvalCommandMatch(prompt: string, tokenPrefix: string): string | null {
  const escapedPrefix = escapeRegex(tokenPrefix)
  const match = prompt.match(new RegExp(`^\\s*${escapedPrefix}\\s+(\\S+)\\s*$`, 'i'))
  return match?.[1] ?? null
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
}): ApprovalRecord {
  const createdAt = nowIso()
  const expiresAt = new Date(Date.now() + params.approvalTtlMinutes * 60_000).toISOString()
  return {
    approvalId: params.approvalId,
    kind: params.kind,
    fingerprint: params.fingerprint,
    repoRoot: params.repoRoot,
    reason: params.reason,
    summary: params.summary,
    createdAt,
    expiresAt,
  }
}
