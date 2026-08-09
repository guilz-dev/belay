import { describe, expect, it } from 'vitest'
import { mintCapabilityGrantForRequest } from '../../core/capability/approval-v3.js'
import {
  BOUNDARY_GRANT_ISSUER_CONTAINER,
  materializeContainerBoundaryGrants,
} from '../../core/capability/boundary-grant-materialize.js'
import { buildShellCapabilityRequest } from '../../core/capability/policy-engine.js'
import { DEFAULT_CONFIG_V4 } from '../../core/config.js'
import {
  buildEffectPlan,
  evaluateEffectPlanPolicy,
  hashEffectPlan,
} from '../../core/effect-ir/index.js'
import type { ApprovalRecord } from '../../core/types.js'
import { verdictTestContext } from '../verdict/helpers.js'

describe('effect plan worlds', () => {
  const ctx = verdictTestContext()

  it('policy world requires approval for remote package acquisition', () => {
    const plan = buildEffectPlan({
      tokens: ['npx', '-y', 'prettier', '--version'],
      cwd: ctx.cwd,
      repoRoot: ctx.repoRoot,
      inputFingerprint: 'fp-world-prettier',
    })
    expect(plan).not.toBeNull()
    if (!plan) {
      throw new Error('expected effect plan')
    }
    const policy = evaluateEffectPlanPolicy(plan, ctx)
    expect(policy.authorizationDecision.outcome).toBe('require_approval')
    expect(policy.decisions.length).toBeGreaterThan(0)
  })

  it('host-integration world does not materialize container grants without prior approval', () => {
    const plan = buildEffectPlan({
      tokens: ['npx', '-y', 'prettier', '--version'],
      cwd: ctx.cwd,
      repoRoot: ctx.repoRoot,
      inputFingerprint: 'fp-world-host',
    })
    expect(plan).not.toBeNull()
    if (!plan) {
      throw new Error('expected effect plan')
    }
    const policy = evaluateEffectPlanPolicy(plan, { ...ctx, attestation: null })
    const networkRequest = policy.capabilityRequests.find(
      (request) => request.action === 'network.connect',
    )
    expect(networkRequest).toBeDefined()
    const materialized = materializeContainerBoundaryGrants(
      networkRequest ? [networkRequest] : [],
      {
        attestation: {
          version: 1,
          driver: 'container',
          probedAt: new Date().toISOString(),
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
          deniesUngrantedEffects: true,
          materializesGrants: true,
          probeSignals: [],
        },
        mountRoot: ctx.cwd,
        egressProxyActive: true,
        existingGrants: [],
      },
    )
    expect(materialized).toHaveLength(0)
  })

  it('container world materializes fs grants for certain repo-local requests', () => {
    const request = buildShellCapabilityRequest({
      command: 'touch notes.txt',
      hookKind: 'shell',
      segmentHead: 'touch',
      effect: 'local_mutation',
      location: 'repo_local',
      opacity: 'transparent',
      pathArgs: [`${ctx.repoRoot}/notes.txt`],
      resolvedPathTargets: [`${ctx.repoRoot}/notes.txt`],
      signals: ['repo_local_write'],
      cwd: ctx.repoRoot,
      repoRoot: ctx.repoRoot,
      inputFingerprint: 'fp-touch',
    })
    const grants = materializeContainerBoundaryGrants([request], {
      attestation: {
        version: 1,
        driver: 'container',
        probedAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        deniesUngrantedEffects: true,
        materializesGrants: true,
        probeSignals: [],
      },
      mountRoot: ctx.repoRoot,
      egressProxyActive: false,
      sensitivePaths: DEFAULT_CONFIG_V4.classifier.sensitivePaths,
    })
    expect(grants).toHaveLength(1)
    expect(grants[0]?.issuer).toBe(BOUNDARY_GRANT_ISSUER_CONTAINER)
  })

  it('record/replay world preserves canonical effect plan hash', () => {
    const params = {
      tokens: ['npx', '-y', 'prettier', '--version'],
      cwd: ctx.cwd,
      repoRoot: ctx.repoRoot,
      inputFingerprint: 'fp-world-record',
    }
    const first = buildEffectPlan(params)
    const second = buildEffectPlan(params)
    expect(first).not.toBeNull()
    expect(second).not.toBeNull()
    if (!first || !second) {
      throw new Error('expected effect plan')
    }
    expect(hashEffectPlan(second)).toBe(hashEffectPlan(first))
  })

  it('fake deny boundary attests enforcement without materializing grants', () => {
    const plan = buildEffectPlan({
      tokens: ['npx', '-y', 'prettier', '--version'],
      cwd: ctx.cwd,
      repoRoot: ctx.repoRoot,
      inputFingerprint: 'fp-world-fake-deny',
    })
    expect(plan).not.toBeNull()
    if (!plan) {
      throw new Error('expected effect plan')
    }
    const policy = evaluateEffectPlanPolicy(plan, {
      ...ctx,
      attestation: {
        version: 1,
        driver: 'container',
        probedAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        deniesUngrantedEffects: true,
        materializesGrants: false,
        probeSignals: [],
      },
    })
    const networkRequest = policy.capabilityRequests.find(
      (request) => request.action === 'network.connect',
    )
    expect(networkRequest).toBeDefined()
    const materialized = materializeContainerBoundaryGrants(
      networkRequest ? [networkRequest] : [],
      {
        attestation: {
          version: 1,
          driver: 'container',
          probedAt: new Date().toISOString(),
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
          deniesUngrantedEffects: true,
          materializesGrants: false,
          probeSignals: [],
        },
        mountRoot: ctx.cwd,
        egressProxyActive: true,
        existingGrants: [],
      },
    )
    expect(materialized).toHaveLength(0)
    expect(policy.authorizationDecision.outcome).toBe('require_approval')
  })

  it('container world materializes boundary grants after approval for certain requests', () => {
    const request = buildShellCapabilityRequest({
      command: 'curl https://example.com',
      hookKind: 'shell',
      segmentHead: 'curl',
      effect: 'remote_mutation',
      location: 'external',
      opacity: 'transparent',
      pathArgs: [],
      signals: ['network_connect'],
      cwd: ctx.cwd,
      repoRoot: ctx.repoRoot,
      inputFingerprint: 'fp-world-curl',
    })
    request.action = 'network.connect'
    request.resource = { kind: 'network', host: 'example.com' }
    expect(request.evidence.level).toBe('certain')

    const approval: ApprovalRecord = {
      approvalId: 'bundle-net-1',
      kind: 'shell',
      fingerprint: 'fp-world-curl',
      repoRoot: ctx.repoRoot,
      reason: 'external_effect',
      summary: 'curl https://example.com',
      createdAt: '2026-01-01T00:00:00.000Z',
      expiresAt: '2026-01-02T00:00:00.000Z',
      approvedAt: '2026-01-01T00:01:00.000Z',
    }
    const approvedGrant = mintCapabilityGrantForRequest({
      approval,
      request,
    })
    const attestation = {
      version: 1 as const,
      driver: 'container' as const,
      probedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      deniesUngrantedEffects: true,
      materializesGrants: true,
      probeSignals: [] as string[],
    }
    const materialized = materializeContainerBoundaryGrants([request], {
      attestation,
      mountRoot: ctx.cwd,
      egressProxyActive: true,
      existingGrants: [approvedGrant],
    })
    expect(materialized).toHaveLength(1)
    expect(materialized[0]?.issuer).toBe(BOUNDARY_GRANT_ISSUER_CONTAINER)

    const bundlePlan = buildEffectPlan({
      tokens: ['npx', '-y', 'prettier', '--version'],
      cwd: ctx.cwd,
      repoRoot: ctx.repoRoot,
      inputFingerprint: 'fp-world-bundle-network',
    })
    expect(bundlePlan).not.toBeNull()
    if (!bundlePlan) {
      throw new Error('expected effect plan')
    }
    const { authorizationDecision } = evaluateEffectPlanPolicy(bundlePlan, {
      ...ctx,
      attestation,
      egressProxyActive: true,
      grants: [approvedGrant, ...materialized],
    })
    expect(authorizationDecision.outcome).toBe('require_approval')
  })
})
