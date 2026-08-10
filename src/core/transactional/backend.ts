import type { BoundaryAttestation } from '../capability/attestation.js'
import type { BelayFileCheckpointConfig } from '../config.js'
import type { TransactionalFileChange } from './types.js'

export type TransactionalBackendId = 'git_worktree' | 'file_checkpoint'

export interface TransactionalBackendProbe {
  eligible: boolean
  backend: TransactionalBackendId
  reason?: string
  signals: string[]
}

export interface TransactionalSnapshot {
  backend: TransactionalBackendId
  resourceRoot: string
  executionRoot: string
  baselineRoot?: string
  resourceIdentity: string
  baselineTreeHash: string
  excludedRoots: string[]
  copyStrategy?: 'clonefile' | 'reflink' | 'copy'
  collectChanges(): Promise<TransactionalFileChange[]>
  cleanup(): Promise<void>
}

export interface TransactionalBackendContext {
  repoRoot: string
  stateDir: string
  cwd: string
  dirtyIgnoreRoots?: string[]
  fileCheckpoint: BelayFileCheckpointConfig
  /** Required for file_checkpoint eligibility once implemented. */
  durableCheckpointEnabled: boolean
  /** Verified boundary attestation for file_checkpoint isolation checks. */
  boundaryAttestation?: BoundaryAttestation | null
  boundaryAttestationFresh?: boolean
}

export interface TransactionalBackend {
  id: TransactionalBackendId
  probe(context: TransactionalBackendContext): Promise<TransactionalBackendProbe>
  prepare(context: TransactionalBackendContext): Promise<TransactionalSnapshot>
}

export interface TransactionalBackendSelection {
  backend: TransactionalBackend | null
  probe: TransactionalBackendProbe
  skipReason?: string
}
