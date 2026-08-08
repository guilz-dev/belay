import type { CapabilityRequestV1 } from '../capability/request.js'

/** Backends that can mint a verifiable RecoveryProof (ADR: proof-only execution). */
export type RecoveryBackend = 'git_worktree' | 'file_checkpoint'

export interface RecoveryProofV1 {
  version: 1
  backend: RecoveryBackend
  inputFingerprint: string
  resourceScope: string
  baseStateHash: string
  effectClosure: 'repo_local_fs'
  issuedAt: string
  expiresAt: string
  probeSignals: string[]
}

export interface RecoveryProofContext {
  repoRoot: string
  cwd: string
  command: string
  requests: CapabilityRequestV1[]
}
