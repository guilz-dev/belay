import { attestsWorkspaceMountIsolation, isAttestationCurrent } from '../capability/attestation.js'
import type { TransactionalBackendContext } from './backend.js'

export const FILE_CHECKPOINT_ISOLATION_UNAVAILABLE = 'file_checkpoint_isolation_unavailable'

export function fileCheckpointIsolationReason(context: TransactionalBackendContext): string | null {
  const attestation = context.boundaryAttestation
  const driverId = context.boundaryDriverId
  if (!attestation || !isAttestationCurrent(attestation) || !driverId) {
    return FILE_CHECKPOINT_ISOLATION_UNAVAILABLE
  }
  if (attestation.driver !== driverId) {
    return FILE_CHECKPOINT_ISOLATION_UNAVAILABLE
  }
  if (!attestsWorkspaceMountIsolation(attestation)) {
    return FILE_CHECKPOINT_ISOLATION_UNAVAILABLE
  }
  return null
}
