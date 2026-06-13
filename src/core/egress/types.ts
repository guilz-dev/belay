export interface EgressConnectRequest {
  host: string
  port: number
  method: 'CONNECT' | 'GET' | 'POST' | 'PUT' | 'DELETE' | 'HEAD' | 'PATCH' | 'OPTIONS'
  hasPayload?: boolean
  repoRoot: string
}

export type EgressDecision = 'allow' | 'deny_pending'

export interface EgressPolicyResult {
  decision: EgressDecision
  fingerprint: string
  summary: string
  reason: string
  approvalId?: string
}

export interface EgressAllowlistEntry {
  host: string
  approvedAt: string
  approvalId?: string
}

export interface EgressAllowlistFile {
  version: 1
  domains: EgressAllowlistEntry[]
}

export type EgressApprovalScope = 'once' | 'domain'
