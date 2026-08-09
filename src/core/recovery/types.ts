import type { CapabilityRequestV1 } from '../capability/request.js'

/** Backends that can mint a verifiable RecoveryProof (ADR: proof-only execution). */
export type RecoveryBackend = 'git_worktree' | 'file_checkpoint'

export interface RecoveryProofV1 {
  version: 1
  backend: RecoveryBackend
  inputFingerprint: string
  resourceScope: string
  baseStateHash: string
  /** The proof covers only filesystem effects observed inside the repository. */
  effectClosure: 'repo_local_fs_observed'
  issuedAt: string
  expiresAt: string
  probeSignals: string[]
}

export type RecoveryCheckpointState =
  | 'prepared'
  | 'applying'
  | 'applied'
  | 'restoring'
  | 'restored'
  | 'conflict'
  | 'corrupt'
  | 'needs_manual_repair'

export type RecoveryFileKind = 'absent' | 'file' | 'symlink'

export interface RecoveryFileSnapshotV1 {
  kind: RecoveryFileKind
  mode?: number
  hash?: string
  blob?: string
  symlinkTarget?: string
}

export interface RecoveryCheckpointEntryV1 {
  path: string
  before: RecoveryFileSnapshotV1
  after: RecoveryFileSnapshotV1
}

export interface RecoveryCheckpointManifestV1 {
  version: 1
  checkpointId: string
  backend: RecoveryBackend
  repoRoot: string
  repoIdentity: string
  commandFingerprint: string
  createdAt: string
  expiresAt: string
  proof: RecoveryProofV1
  entries: RecoveryCheckpointEntryV1[]
}

export type RecoveryFileSnapshotV2 =
  | RecoveryFileSnapshotV1
  | { kind: 'directory'; mode: number; hash: string }

export interface RecoveryCheckpointEntryV2 {
  path: string
  before: RecoveryFileSnapshotV2
  after: RecoveryFileSnapshotV2
}

export type RecoveryCheckpointEntry = RecoveryCheckpointEntryV1 | RecoveryCheckpointEntryV2

export interface RecoveryCheckpointManifestV2 {
  version: 2
  checkpointId: string
  backend: RecoveryBackend
  repoRoot: string
  resourceKind: 'git_repository' | 'directory'
  repoIdentity: string
  commandFingerprint: string
  createdAt: string
  expiresAt: string
  proof: RecoveryProofV1
  entries: RecoveryCheckpointEntryV2[]
}

export type RecoveryCheckpointManifest = RecoveryCheckpointManifestV1 | RecoveryCheckpointManifestV2

export interface RecoveryCheckpointStateV1 {
  version: 1
  state: RecoveryCheckpointState
  updatedAt: string
  manifestHash: string
  detail?: string
}

export interface RecoveryReceiptV1 {
  version: 1
  checkpointId: string
  manifestHash: string
  proofHash: string
  postStateHash: string
  appliedAt: string
  changeCount: number
}

export interface RecoveryCheckpointSummary {
  checkpointId: string
  state: RecoveryCheckpointState
  /** Operator-facing detail from durable checkpoint state (e.g. mixed-state reason). */
  stateDetail?: string
  backend: RecoveryBackend
  repoRoot: string
  commandFingerprint: string
  createdAt: string
  expiresAt: string
  changeCount: number
  manifestHash: string
  receiptHash?: string
  proofHash?: string
  postStateHash?: string
}

export interface RecoveryProofContext {
  repoRoot: string
  cwd: string
  command: string
  requests: CapabilityRequestV1[]
}
