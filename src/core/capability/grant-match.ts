import { canonicalPath } from '../path-utils.js'
import type { CapabilityGrantV1 } from './grant.js'
import { isGrantScopeTooBroad } from './grant.js'
import type { CapabilityPrincipal, CapabilityRequestV1 } from './request.js'

function principalMatches(grant: CapabilityPrincipal, request: CapabilityPrincipal): boolean {
  if (grant.repoRoot !== request.repoRoot) {
    return false
  }
  if (request.adapter !== undefined && grant.adapter !== request.adapter) {
    return false
  }
  if (request.sessionHash !== undefined && grant.sessionHash !== request.sessionHash) {
    return false
  }
  if (grant.adapter !== undefined && grant.adapter !== request.adapter) {
    return false
  }
  if (grant.sessionHash !== undefined && grant.sessionHash !== request.sessionHash) {
    return false
  }
  return true
}

function networkResourceMatches(
  grant: Extract<CapabilityGrantV1['resource'], { kind: 'network' }>,
  request: Extract<CapabilityRequestV1['resource'], { kind: 'network' }>,
): boolean {
  if (grant.host !== request.host) {
    return false
  }
  if (grant.port !== undefined && grant.port !== request.port) {
    return false
  }
  if (
    grant.protocol !== undefined &&
    grant.protocol !== 'unknown' &&
    request.protocol !== undefined &&
    request.protocol !== 'unknown' &&
    grant.protocol !== request.protocol
  ) {
    return false
  }
  return true
}

function grantTargetsResource(grant: CapabilityGrantV1, request: CapabilityRequestV1): boolean {
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
    return networkResourceMatches(grant.resource, request.resource)
  }
  if (grant.resource.kind === 'executable' && request.resource.kind === 'executable') {
    return grant.resource.command === request.resource.command
  }
  if (grant.resource.kind === 'package-cache' && request.resource.kind === 'package-cache') {
    return grant.resource.manager === request.resource.manager
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

export function grantTargetsRequest(
  grant: CapabilityGrantV1,
  request: CapabilityRequestV1,
): boolean {
  if (grant.usesRemaining <= 0) {
    return false
  }
  if (!principalMatches(grant.principal, request.principal)) {
    return false
  }
  return grantTargetsResource(grant, request)
}

/** Repo-scoped target match for forged broad-grant detection (principal may be incomplete). */
export function broadGrantTargetsRequest(
  grant: CapabilityGrantV1,
  request: CapabilityRequestV1,
): boolean {
  if (grant.principal.repoRoot !== request.principal.repoRoot) {
    return false
  }
  return grantTargetsResource(grant, request)
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
