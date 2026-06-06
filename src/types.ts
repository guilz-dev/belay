export type BelayMode = 'enforce' | 'audit'

export type HookVerdict = 'allow' | 'allow_flagged' | 'deny_pending_approval'

export interface BelayConfig {
  version: 1
  mode: BelayMode
  approvalTtlMinutes: number
  tokenPrefix: string
  gates: {
    shell: boolean
    subagent: boolean
  }
  audit: {
    logPath: string
  }
}

export interface ApprovalRecord {
  approvalId: string
  kind: 'shell' | 'subagent'
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

export interface HookEntry {
  command: string
  matcher?: string
}

export interface HooksFile {
  version: number
  hooks: Record<string, HookEntry[]>
}

export interface InitOptions {
  targetDir?: string
  withSkill?: boolean
  /** @deprecated Use withSkill instead. */
  nightly?: boolean
}

export interface DoctorOptions {
  targetDir?: string
}

export interface DoctorReport {
  ok: boolean
  repoRoot: string
  configPath: string
  hooksPath: string
  nodeResolution: {
    ok: boolean
    detail: string
    path?: string
  }
  issues: string[]
  notes: string[]
}
