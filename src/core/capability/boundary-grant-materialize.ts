import path from 'node:path'

import { matchesSensitivePath } from '../glob.js'
import { canonicalPath, pathWithinRoot } from '../path-utils.js'
import { newGrantId } from './approval-v3.js'
import type { BoundaryAttestation } from './attestation.js'
import { isAttestationFresh } from './attestation.js'
import { CAPABILITY_GRANT_VERSION, type CapabilityGrantV1 } from './grant.js'
import { grantMatchesRequest } from './grant-match.js'
import type { CapabilityRequestV1 } from './request.js'

const BOUNDARY_GRANT_TTL_MS = 15 * 60_000
export const BOUNDARY_GRANT_ISSUER_CONTAINER = 'boundary:container' as const

function resolveCapabilityPath(targetPath: string, cwd: string): string {
  const joined = path.isAbsolute(targetPath) ? targetPath : path.join(cwd, targetPath)
  return canonicalPath(joined)
}

export function isPathWithinBoundaryMount(request: CapabilityRequestV1): boolean {
  if (request.resource.kind !== 'path') {
    return true
  }
  const mountRoot = canonicalPath(request.context.cwd)
  const resolved = resolveCapabilityPath(request.resource.path, request.context.cwd)
  return pathWithinRoot(mountRoot, resolved)
}

function mintBoundaryGrant(
  request: CapabilityRequestV1,
  attestation: BoundaryAttestation,
  issuer: string,
): CapabilityGrantV1 {
  const now = Date.now()
  const attestationExpiry = Date.parse(attestation.expiresAt)
  const grantExpiry = now + BOUNDARY_GRANT_TTL_MS
  const expiresAt = new Date(
    Number.isFinite(attestationExpiry) ? Math.min(attestationExpiry, grantExpiry) : grantExpiry,
  ).toISOString()
  return {
    version: CAPABILITY_GRANT_VERSION,
    grantId: newGrantId(),
    principal: request.principal,
    action: request.action,
    resource: request.resource,
    inputFingerprint: request.context.inputFingerprint,
    issuedAt: new Date(now).toISOString(),
    expiresAt,
    maxUses: 1,
    usesRemaining: 1,
    issuer,
  }
}

export interface MaterializeBoundaryGrantParams {
  attestation: BoundaryAttestation
  mountRoot: string
  egressProxyActive: boolean
  existingGrants?: CapabilityGrantV1[]
  sensitivePaths?: string[]
}

export function materializeContainerBoundaryGrant(
  request: CapabilityRequestV1,
  params: MaterializeBoundaryGrantParams,
): CapabilityGrantV1 | null {
  if (!isAttestationFresh(params.attestation)) {
    return null
  }
  if (!params.attestation.materializesGrants || params.attestation.driver !== 'container') {
    return null
  }
  if (request.evidence.level !== 'certain') {
    return null
  }

  const repoRoot = canonicalPath(request.principal.repoRoot)
  const mountRoot = canonicalPath(params.mountRoot)

  if (request.action === 'fs.read' || request.action === 'fs.write') {
    if (request.resource.kind !== 'path') {
      return null
    }
    const resolved = resolveCapabilityPath(request.resource.path, request.context.cwd)
    if (!pathWithinRoot(repoRoot, resolved) || !pathWithinRoot(mountRoot, resolved)) {
      return null
    }
    const relative = resolved.slice(repoRoot.length).replace(/^[/\\]/, '')
    if (params.sensitivePaths?.length && matchesSensitivePath(relative, params.sensitivePaths)) {
      return null
    }
    return mintBoundaryGrant(request, params.attestation, BOUNDARY_GRANT_ISSUER_CONTAINER)
  }

  if (request.action === 'network.connect' && request.resource.kind === 'network') {
    if (!params.egressProxyActive) {
      return null
    }
    const approved = params.existingGrants?.some(
      (grant) =>
        grant.issuer !== BOUNDARY_GRANT_ISSUER_CONTAINER && grantMatchesRequest(grant, request),
    )
    if (!approved) {
      return null
    }
    return mintBoundaryGrant(request, params.attestation, BOUNDARY_GRANT_ISSUER_CONTAINER)
  }

  return null
}

export function materializeContainerBoundaryGrants(
  requests: readonly CapabilityRequestV1[],
  params: MaterializeBoundaryGrantParams,
): CapabilityGrantV1[] {
  const grants: CapabilityGrantV1[] = []
  let existing = [...(params.existingGrants ?? [])]
  for (const request of requests) {
    const materialized = materializeContainerBoundaryGrant(request, {
      ...params,
      existingGrants: existing,
    })
    if (materialized) {
      grants.push(materialized)
      existing = [...existing, materialized]
    }
  }
  return grants
}
