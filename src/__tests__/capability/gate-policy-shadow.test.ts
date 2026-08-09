import { describe, expect, it } from 'vitest'
import {
  BOUNDARY_PROFILE_L1_ATTESTED,
  BOUNDARY_PROFILE_L3_L4_ONLY,
} from '../../core/capability/boundary-profile.js'
import {
  capabilityDecisionAuditFields,
  scheduleGateShadowAudit,
} from '../../core/capability/gate-policy-shadow.js'
import { DEFAULT_CONFIG_V4 } from '../../core/config.js'
import {
  buildEffectPlan,
  effectPlanAuditFields,
  evaluateEffectPlanPolicy,
  hashEffectPlan,
} from '../../core/effect-ir/index.js'
import type { ClassifyResult } from '../../core/types.js'
import { normalizeJudgeRuntimeConfig } from '../../core/verdict/judge-runtime-config.js'
import { verdictTestContext } from '../verdict/helpers.js'

const result: ClassifyResult = {
  verdict: 'deny_pending_approval',
  reason: 'outside_repo_mutation',
  summary: 'curl example.com',
  fingerprint: 'fp',
  assessment: {
    reversibility: 'irreversible',
    external: true,
    blastRadius: 'outside the repository',
    confidence: 0.9,
    signals: ['network_connect'],
  },
}

describe('scheduleGateShadowAudit', () => {
  it('defers judge shadow without scheduling transport on the gate path', () => {
    const runtime = normalizeJudgeRuntimeConfig(DEFAULT_CONFIG_V4.judge.runtime)
    const trace = scheduleGateShadowAudit({
      repoRoot: '/repo',
      config: {
        ...DEFAULT_CONFIG_V4,
        judge: {
          ...DEFAULT_CONFIG_V4.judge,
          mode: 'shadow',
          runtime: {
            ...runtime,
            shadow: {
              ...runtime.shadow,
              enabled: true,
            },
          },
        },
      },
      providerId: 'cursor',
      result,
    })
    expect(trace.judgeShadowDeferred).toBe(true)
    expect(trace.judgeShadowScheduled).toBe(false)
    expect(trace.judgeShadowQueued).toBeUndefined()
  })

  it('queues deferred shadow work when a command is available', () => {
    const runtime = normalizeJudgeRuntimeConfig(DEFAULT_CONFIG_V4.judge.runtime)
    const trace = scheduleGateShadowAudit({
      repoRoot: '/repo',
      config: {
        ...DEFAULT_CONFIG_V4,
        judge: {
          ...DEFAULT_CONFIG_V4.judge,
          mode: 'shadow',
          runtime: {
            ...runtime,
            shadow: {
              ...runtime.shadow,
              enabled: true,
              sampleRate: 1,
              sampleRateMax: 1,
              providerAllowlist: ['cursor'],
            },
          },
        },
      },
      providerId: 'cursor',
      result,
      command: 'curl https://example.com',
    })
    expect(trace.judgeShadowDeferred).toBe(true)
    expect(trace.judgeShadowQueued).toBe(true)
  })

  it('records effect plan audit fields for composite package exec classification', () => {
    const ctx = verdictTestContext()
    const plan = buildEffectPlan({
      tokens: ['npx', '-y', 'prettier', '--version'],
      cwd: ctx.cwd,
      repoRoot: ctx.repoRoot,
      inputFingerprint: 'fp-shadow-prettier',
    })
    expect(plan).not.toBeNull()
    if (!plan) {
      throw new Error('expected effect plan')
    }
    const result: ClassifyResult = {
      verdict: 'deny_pending_approval',
      reason: 'external_effect',
      summary: 'npx -y prettier --version',
      fingerprint: 'fp-shadow-prettier',
      boundaryProfile: BOUNDARY_PROFILE_L3_L4_ONLY,
      assessment: {
        reversibility: 'irreversible',
        external: true,
        blastRadius: 'outside the repository',
        confidence: 0.9,
        signals: ['network_connect'],
      },
      effectPlan: plan,
      effectPlanPolicyDecisions: [
        {
          outcome: 'require_approval',
          reason: 'external_effect',
          signals: ['network_connect'],
          matchedRule: 'builtin.network',
        },
      ],
    }
    const fields = capabilityDecisionAuditFields(result)
    expect(fields.boundaryEnforcement).toBe('prediction_only')
    expect(fields.effectIRHash).toBe(hashEffectPlan(plan))
    expect(fields.effectPlanRequestDecisions).toEqual([
      {
        outcome: 'require_approval',
        reason: 'external_effect',
        matchedRule: 'builtin.network',
      },
    ])
    expect(fields.effectPlanRequirements).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          action: 'fs.write',
          resource: { kind: 'package-cache', manager: 'npm' },
          provenance: expect.objectContaining({ phase: 'cache_write' }),
        }),
      ]),
    )

    const policy = evaluateEffectPlanPolicy(plan, ctx)
    const auditFields = effectPlanAuditFields(plan, policy)
    expect(auditFields.effectPlanCacheWriteProjected).toBe(true)
    expect(auditFields.effectPlanRequirements).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          action: 'fs.write',
          resource: { kind: 'package-cache', manager: 'npm' },
          provenance: expect.objectContaining({ phase: 'cache_write' }),
        }),
      ]),
    )
  })

  it('does not claim runtime enforcement unless every effect was boundary-verified', () => {
    const fields = capabilityDecisionAuditFields({
      ...result,
      boundaryProfile: BOUNDARY_PROFILE_L1_ATTESTED,
      effectPlanPolicyDecisions: [
        {
          outcome: 'allow',
          reason: 'verified_boundary',
          signals: ['verified_boundary'],
          matchedRule: 'boundary.verified',
        },
        {
          outcome: 'allow',
          reason: 'capability_grant',
          signals: ['capability_grant'],
          matchedRule: 'grant.exact',
        },
      ],
    })

    expect(fields.boundaryEnforcement).toBe('prediction_only')
  })

  it('reports runtime enforcement when every effect was boundary-verified', () => {
    const fields = capabilityDecisionAuditFields({
      ...result,
      boundaryProfile: BOUNDARY_PROFILE_L1_ATTESTED,
      effectPlanPolicyDecisions: [
        {
          outcome: 'allow',
          reason: 'verified_boundary',
          signals: ['verified_boundary'],
          matchedRule: 'boundary.verified',
        },
      ],
    })

    expect(fields.boundaryEnforcement).toBe('runtime_attested')
  })
})
