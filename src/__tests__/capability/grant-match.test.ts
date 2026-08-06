import { describe, expect, it } from 'vitest'

import { mintCapabilityGrant } from '../../core/capability/approval-v3.js'
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
})
