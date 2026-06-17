export type CapabilityApprovalScope = 'once' | 'path' | 'workspace-root'

export interface FsScopeAllowlistEntry {
  path: string
  approvedAt: string
  approvalId: string
}

export interface FsScopeAllowlistFile {
  version: 1
  paths: FsScopeAllowlistEntry[]
}

export interface TrustedWorkspaceRootEntry {
  path: string
  approvedAt: string
  approvalId: string
  source?: 'approval'
}

export interface TrustedWorkspaceRootsFile {
  version: 1
  roots: TrustedWorkspaceRootEntry[]
}
