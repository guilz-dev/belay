import { describe, expect, it } from 'vitest'

import { mintCapabilityGrant } from '../../core/capability/approval-v3.js'
import { isGrantScopeTooBroad } from '../../core/capability/grant.js'
import { grantMatchesRequest } from '../../core/capability/grant-match.js'
import type { CapabilityRequestV1 } from '../../core/capability/request.js'
import type { ApprovalRecord } from '../../core/types.js'

const request: CapabilityRequestV1 = {
  version: 1,
  principal: { repoRoot: '/repo', sessionHash: 'sess' },
  action: 'fs.write',
  resource: { kind: 'path', path: '/repo/README.md' },
  context: {
    hookKind: 'shell',
    cwd: '/repo',
    inputFingerprint: 'fp1',
    analysisBasis: [],
  },
  evidence: {
    level: 'certain',
    signals: ['repo_local_write'],
  },
}

function grantForRequest(pathValue: string) {
  const approval: ApprovalRecord = {
    approvalId: 'a1',
    kind: 'shell',
    fingerprint: 'fp',
    repoRoot: '/repo',
    reason: 'outside_repo_mutation',
    summary: 'echo hi',
    createdAt: '2026-01-01T00:00:00.000Z',
    expiresAt: '2099-01-02T00:00:00.000Z',
    approvedAt: '2026-01-01T00:01:00.000Z',
    capabilityRequests: [request],
  }
  return mintCapabilityGrant({
    approval,
    capabilityRequests: [
      {
        ...request,
        resource: { kind: 'path', path: pathValue },
      },
    ],
  })
}

describe('grantMatchesRequest', () => {
  it('matches path grants after canonicalization', () => {
    const grant = grantForRequest('/repo/./README.md')
    if (!grant) {
      throw new Error('expected grant')
    }
    expect(grantMatchesRequest(grant, request)).toBe(true)
  })

  it('rejects grants with no uses remaining', () => {
    const grant = grantForRequest('/repo/README.md')
    if (!grant) {
      throw new Error('expected grant')
    }
    expect(grantMatchesRequest({ ...grant, usesRemaining: 0 }, request)).toBe(false)
  })

  it('rejects grants when principal session hash differs', () => {
    const grant = grantForRequest('/repo/README.md')
    if (!grant) {
      throw new Error('expected grant')
    }
    const otherSession: CapabilityRequestV1 = {
      ...request,
      principal: { ...request.principal, sessionHash: 'other-session' },
    }
    expect(grantMatchesRequest(grant, otherSession)).toBe(false)
  })

  it('rejects grants when principal adapter differs', () => {
    const grant = grantForRequest('/repo/README.md')
    if (!grant) {
      throw new Error('expected grant')
    }
    const scopedGrant = {
      ...grant,
      principal: { ...grant.principal, adapter: 'cursor' as const },
    }
    const otherAdapter: CapabilityRequestV1 = {
      ...request,
      principal: { ...request.principal, adapter: 'codex' },
    }
    expect(grantMatchesRequest(scopedGrant, otherAdapter)).toBe(false)
  })

  it('rejects grants missing adapter when request specifies adapter', () => {
    const grant = grantForRequest('/repo/README.md')
    if (!grant) {
      throw new Error('expected grant')
    }
    const requestWithAdapter: CapabilityRequestV1 = {
      ...request,
      principal: { ...request.principal, adapter: 'cursor' },
    }
    expect(grantMatchesRequest(grant, requestWithAdapter)).toBe(false)
  })

  it('rejects wildcard network host grants', () => {
    const approval: ApprovalRecord = {
      approvalId: 'a2',
      kind: 'tool',
      fingerprint: 'fp',
      repoRoot: '/repo',
      reason: 'network_connect',
      summary: 'curl example.com',
      createdAt: '2026-01-01T00:00:00.000Z',
      expiresAt: '2099-01-02T00:00:00.000Z',
      approvedAt: '2026-01-01T00:01:00.000Z',
      capabilityRequests: [],
    }
    const networkRequest: CapabilityRequestV1 = {
      version: 1,
      principal: { repoRoot: '/repo', sessionHash: 'sess' },
      action: 'network.connect',
      resource: { kind: 'network', host: 'example.com', port: 443, protocol: 'https' },
      context: {
        hookKind: 'shell',
        cwd: '/repo',
        inputFingerprint: 'fp-net',
        analysisBasis: [],
      },
      evidence: { level: 'certain', signals: ['network_connect'] },
    }
    const grant = mintCapabilityGrant({
      approval,
      capabilityRequests: [
        {
          ...networkRequest,
          resource: { kind: 'network', host: '*', port: 443, protocol: 'https' },
        },
      ],
    })
    if (!grant) {
      throw new Error('expected grant')
    }
    expect(isGrantScopeTooBroad(grant)).toBe(true)
    expect(grantMatchesRequest(grant, networkRequest)).toBe(false)
  })
})
