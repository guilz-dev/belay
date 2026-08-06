import type { CapabilityAction, CapabilityPrincipal, CapabilityResource } from './request.js'

export const CAPABILITY_GRANT_VERSION = 1 as const

export interface CapabilityGrantV1 {
  version: typeof CAPABILITY_GRANT_VERSION
  grantId: string
  principal: CapabilityPrincipal
  action: CapabilityAction
  resource: CapabilityResource
  inputFingerprint?: string
  issuedAt: string
  expiresAt: string
  maxUses: number
  usesRemaining: number
  issuer: string
}

export function isGrantScopeTooBroad(grant: CapabilityGrantV1): boolean {
  if (grant.action === 'network.connect' && grant.resource.kind === 'unknown') {
    return true
  }
  if (grant.resource.kind === 'network' && grant.resource.host === '*') {
    return true
  }
  if (grant.action === 'fs.write' && grant.resource.kind === 'unknown') {
    return true
  }
  if (grant.action === 'indeterminate') {
    return true
  }
  return false
}
