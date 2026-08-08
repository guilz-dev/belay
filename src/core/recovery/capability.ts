import type { CapabilityRequestV1 } from '../capability/request.js'

const NON_RECOVERABLE_ACTIONS = new Set([
  'network.connect',
  'git.ref.write',
  'control_plane.write',
  'secret.read',
  'indeterminate',
])

/** Actions that cannot be closed by local git-worktree / file checkpoint recovery. */
export function capabilityRequestsBlockRecovery(
  requests: CapabilityRequestV1[] | undefined,
): boolean {
  if (!requests?.length) {
    return false
  }
  for (const request of requests) {
    if (NON_RECOVERABLE_ACTIONS.has(request.action)) {
      return true
    }
    if (request.evidence.level === 'indeterminate') {
      return true
    }
  }
  return false
}
