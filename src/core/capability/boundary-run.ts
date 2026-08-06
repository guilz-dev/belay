import type { ClassifyResult } from '../types.js'

export interface BoundaryRunOptions {
  /** When true, container driver mounts the working directory read-only. */
  mountReadOnly?: boolean
}

export function boundaryMountReadOnlyFromPrediction(predicted: ClassifyResult): boolean {
  const effect = predicted.axes?.effect
  if (effect === 'local_mutation' || effect === 'remote_mutation') {
    return false
  }

  const action = predicted.capabilityRequests?.[0]?.action
  if (action === 'fs.write' || action === 'git.ref.write' || action === 'control_plane.write') {
    return false
  }
  if (action === 'fs.read') {
    return true
  }
  if (action === 'network.connect' || action === 'process.exec' || action === 'indeterminate') {
    return true
  }
  return true
}
