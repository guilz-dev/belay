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

export type NetworkMode = 'read' | 'mutate' | 'ambiguous'

export type NetworkPayload = 'none' | 'present' | 'secret'

export type ProcessOperation = 'inspect' | 'spawn' | 'signal'

export type GitRefScope = 'local' | 'remote'

export interface CapabilityPrincipal {
  adapter?: string
  repoRoot: string
  sessionHash?: string
}

export type CapabilityResource =
  | { kind: 'path'; path: string }
  | {
      kind: 'network'
      host: string
      port?: number
      protocol?: string
      mode?: NetworkMode
      payload?: NetworkPayload
    }
  | { kind: 'executable'; command: string; operation?: ProcessOperation }
  | { kind: 'package-cache'; manager: 'npm' | 'pnpm' }
  | { kind: 'git-ref'; ref: string; scope?: GitRefScope; repoPath?: string }
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
