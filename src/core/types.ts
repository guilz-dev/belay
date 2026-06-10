export type BelayMode = 'enforce' | 'audit'

export type HookVerdict = 'allow' | 'allow_flagged' | 'deny_pending_approval'

export type Reversibility = 'reversible' | 'recoverable_with_cost' | 'irreversible'

export interface Assessment {
  reversibility: Reversibility
  external: boolean
  blastRadius: string
  confidence: number
  signals: string[]
}

export interface ClassifyResult {
  verdict: HookVerdict
  reason: string
  fingerprint: string
  assessment: Assessment
  normalizedCommand?: string
  summary?: string
}

export interface ClassifierOptions {
  strictChains?: boolean
  customExternalCommands?: string[]
  customAllowCommands?: string[]
  sensitivePaths?: string[]
}

export interface ApprovalRecord {
  approvalId: string
  kind: 'shell' | 'subagent' | 'tool' | 'tool'
  fingerprint: string
  repoRoot: string
  reason: string
  summary: string
  createdAt: string
  expiresAt: string
  approvedAt?: string
}

export interface ApprovalStateFile {
  version: 1
  approvals: ApprovalRecord[]
}
