import { describe, expect, it } from 'vitest'

import {
  attachCapabilityEnvelope,
  mintCapabilityGrant,
  mintCapabilityGrantBundle,
  mintGrantForApprovedRecord,
  normalizeApprovalGrants,
  upgradeApprovalStateToV3,
} from '../../core/capability/approval-v3.js'
import { hashCapabilityRequests } from '../../core/capability/capability-request-hash.js'
import type { CapabilityRequestV1 } from '../../core/capability/request.js'
import type { ApprovalRecord } from '../../core/types.js'

const sampleRequest: CapabilityRequestV1 = {
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

describe('approval v3', () => {
  it('upgrades legacy approval state and backfills capability hashes', () => {
    const upgraded = upgradeApprovalStateToV3({
      version: 2,
      approvals: [
        {
          approvalId: 'a1',
          kind: 'shell',
          fingerprint: 'fp',
          repoRoot: '/repo',
          reason: 'outside_repo_mutation',
          summary: 'touch /tmp/x',
          createdAt: '2026-01-01T00:00:00.000Z',
          expiresAt: '2026-01-02T00:00:00.000Z',
          capabilityRequests: [sampleRequest],
        },
      ],
    })
    expect(upgraded.version).toBe(3)
    expect(upgraded.approvals[0]?.capabilityRequestHash).toBe(
      hashCapabilityRequests([sampleRequest]),
    )
  })

  it('mints a scoped grant when approval is recorded', () => {
    const pending: ApprovalRecord = attachCapabilityEnvelope(
      {
        approvalId: 'belay_test',
        kind: 'shell',
        fingerprint: 'fp',
        repoRoot: '/repo',
        reason: 'outside_repo_mutation',
        summary: 'touch /tmp/x',
        createdAt: '2026-01-01T00:00:00.000Z',
        expiresAt: '2026-01-02T00:00:00.000Z',
        approvedAt: '2026-01-01T00:01:00.000Z',
      },
      [sampleRequest],
    )
    const grant = mintCapabilityGrant({
      approval: pending,
      capabilityRequests: pending.capabilityRequests ?? [],
    })
    expect(grant?.grantId).toBe('grant_belay_test')
    expect(grant?.usesRemaining).toBe(1)

    const approved = mintGrantForApprovedRecord(pending)
    expect(approved.grant?.grantId).toBe('grant_belay_test')
    expect(approved.grants).toHaveLength(1)
  })

  it('mints a grant per capability request in a bundle', () => {
    const networkRequest: CapabilityRequestV1 = {
      ...sampleRequest,
      action: 'network.connect',
      resource: { kind: 'network', host: 'registry.npmjs.org', protocol: 'registry' },
      context: { ...sampleRequest.context, inputFingerprint: 'fp-net' },
      evidence: { level: 'possible', signals: ['package_acquire_possible'] },
    }
    const pending = attachCapabilityEnvelope(
      {
        approvalId: 'bundle_test',
        kind: 'shell',
        fingerprint: 'fp',
        repoRoot: '/repo',
        reason: 'external_effect',
        summary: 'npx prettier',
        createdAt: '2026-01-01T00:00:00.000Z',
        expiresAt: '2026-01-02T00:00:00.000Z',
        approvedAt: '2026-01-01T00:01:00.000Z',
      },
      [sampleRequest, networkRequest],
    )
    const grants = mintCapabilityGrantBundle({
      approval: pending,
      capabilityRequests: pending.capabilityRequests ?? [],
    })
    expect(grants).toHaveLength(2)
    expect(grants[0]?.grantId).toBe('grant_bundle_test_0')
    expect(grants[1]?.grantId).toBe('grant_bundle_test_1')
  })

  it('dual-reads legacy single grant as a one-element bundle', () => {
    const grant =
      mintCapabilityGrant({
        approval: {
          approvalId: 'legacy1',
          kind: 'shell',
          fingerprint: 'fp',
          repoRoot: '/repo',
          reason: 'outside_repo_mutation',
          summary: 'touch x',
          createdAt: '2026-01-01T00:00:00.000Z',
          expiresAt: '2026-01-02T00:00:00.000Z',
          approvedAt: '2026-01-01T00:01:00.000Z',
        },
        capabilityRequests: [sampleRequest],
      }) ?? undefined
    const legacy: ApprovalRecord = {
      approvalId: 'legacy1',
      kind: 'shell',
      fingerprint: 'fp',
      repoRoot: '/repo',
      reason: 'outside_repo_mutation',
      summary: 'touch x',
      createdAt: '2026-01-01T00:00:00.000Z',
      expiresAt: '2026-01-02T00:00:00.000Z',
      approvedAt: '2026-01-01T00:01:00.000Z',
      capabilityRequests: [sampleRequest],
      grant,
    }
    const normalized = normalizeApprovalGrants(legacy)
    expect(normalized.grants).toHaveLength(1)
    expect(normalized.grant?.grantId).toBe('grant_legacy1')
    const minted = mintGrantForApprovedRecord(legacy)
    expect(minted.grants?.length ?? 0).toBeGreaterThan(0)
  })

  it('stores effect plan hash on capability envelope', () => {
    const pending = attachCapabilityEnvelope(
      {
        approvalId: 'effect1',
        kind: 'shell',
        fingerprint: 'fp',
        repoRoot: '/repo',
        reason: 'external_effect',
        summary: 'npx prettier',
        createdAt: '2026-01-01T00:00:00.000Z',
        expiresAt: '2026-01-02T00:00:00.000Z',
      },
      [sampleRequest],
      'effect-hash-abc',
    )
    expect(pending.effectPlanHash).toBe('effect-hash-abc')
  })
})
