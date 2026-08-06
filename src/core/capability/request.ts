export const CAPABILITY_REQUEST_VERSION = 1 as const

export type CapabilityAction =
  | 'fs.read'
  | 'fs.write'
  | 'process.exec'
  | 'network.connect'
  | 'secret.read'
  | 'git.ref.write'
  | 'control_plane.write'
  | 'indeterminate'

export type CapabilityEvidenceLevel = 'certain' | 'possible' | 'indeterminate'

export type CapabilityHookKind = 'shell' | 'tool' | 'subagent'

export interface CapabilityPrincipal {
  adapter?: string
  repoRoot: string
  sessionHash?: string
}

export type CapabilityResource =
  | { kind: 'path'; path: string }
  | { kind: 'network'; host: string; port?: number; protocol?: string }
  | { kind: 'executable'; command: string }
  | { kind: 'git-ref'; ref: string }
  | { kind: 'unknown' }

export interface CapabilityRequestContext {
  cwd: string
  inputFingerprint: string
  hookKind: CapabilityHookKind
  analysisBasis: string[]
  boundaryProfile?: string
}

export interface CapabilityEvidence {
  level: CapabilityEvidenceLevel
  signals: string[]
}

export interface CapabilityRequestV1 {
  version: typeof CAPABILITY_REQUEST_VERSION
  principal: CapabilityPrincipal
  action: CapabilityAction
  resource: CapabilityResource
  context: CapabilityRequestContext
  evidence: CapabilityEvidence
}
