import { canonicalPath } from '../path-utils.js'
import type { CapabilityGrantV1 } from './grant.js'
import { isGrantScopeTooBroad } from './grant.js'
import type { CapabilityRequestV1 } from './request.js'

export function grantTargetsRequest(
  grant: CapabilityGrantV1,
  request: CapabilityRequestV1,
): boolean {
  if (grant.usesRemaining <= 0) {
    return false
  }
  if (grant.principal.repoRoot !== request.principal.repoRoot) {
    return false
  }
  if (grant.action !== request.action) {
    if (grant.action === 'indeterminate') {
      return request.action === 'indeterminate'
    }
    return false
  }
  if (grant.inputFingerprint && grant.inputFingerprint !== request.context.inputFingerprint) {
    return false
  }
  if (grant.resource.kind === 'path' && request.resource.kind === 'path') {
    return canonicalPath(grant.resource.path) === canonicalPath(request.resource.path)
  }
  if (grant.resource.kind === 'network' && request.resource.kind === 'network') {
    return grant.resource.host === request.resource.host
  }
  if (grant.resource.kind === 'executable' && request.resource.kind === 'executable') {
    return grant.resource.command === request.resource.command
  }
  if (grant.resource.kind === 'git-ref' && request.resource.kind === 'git-ref') {
    return grant.resource.ref === request.resource.ref
  }
  if (grant.resource.kind === 'unknown') {
    if (grant.action === 'network.connect' && request.resource.kind === 'network') {
      return true
    }
    if (grant.action === 'fs.write' && request.resource.kind === 'path') {
      return true
    }
    if (grant.action === 'indeterminate') {
      return request.action === 'indeterminate'
    }
  }
  return grant.resource.kind === request.resource.kind
}

export function grantMatchesRequest(
  grant: CapabilityGrantV1,
  request: CapabilityRequestV1,
): boolean {
  if (isGrantScopeTooBroad(grant)) {
    return false
  }
  return grantTargetsRequest(grant, request)
}
