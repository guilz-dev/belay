import { describe, expect, it } from 'vitest'

import { hashDecisionConfig } from '../core/decision-config-fingerprint.js'
import { mergeConfig } from '../core/config.js'
import {
  matchesAuditCohort,
  resolveRuntimeArtifactHash,
} from '../runtime-provenance.js'

describe('decision config fingerprint', () => {
  it('keeps decisionConfigFingerprint stable when only mode changes', () => {
    const enforce = mergeConfig({ mode: 'enforce' })
    const observe = mergeConfig({ mode: 'observe' })
    expect(hashDecisionConfig(enforce)).toBe(hashDecisionConfig(observe))
  })

  it('changes decisionConfigFingerprint when authorization-relevant fields change', () => {
    const sandboxed = mergeConfig({ sandbox: { enabled: true, runtime: 'container' } })
    const unsandboxed = mergeConfig({ sandbox: { enabled: false, runtime: 'none' } })
    expect(hashDecisionConfig(sandboxed)).not.toBe(hashDecisionConfig(unsandboxed))
  })

  it('accepts only 64-hex runtime artifact hashes', () => {
    const valid = 'a'.repeat(64)
    expect(resolveRuntimeArtifactHash(valid)).toBe(valid)
    expect(resolveRuntimeArtifactHash('abc123deadbeef')).toBeUndefined()
    expect(resolveRuntimeArtifactHash(undefined)).toBeUndefined()
  })
})

describe('matchesAuditCohort boundary profile', () => {
  const cohort = {
    runtimeArtifactHash: 'a'.repeat(64),
    decisionConfigFingerprint: 'decision-fingerprint',
    boundaryProfile: 'l3-l4-only',
    runtimeBuildStamp: '0.8.0@stamp',
    configFingerprint: 'config-fingerprint',
  }

  it('matches v3 records with the same boundary profile', () => {
    expect(
      matchesAuditCohort(
        {
          runtimeArtifactHash: cohort.runtimeArtifactHash,
          decisionConfigFingerprint: cohort.decisionConfigFingerprint,
          boundaryProfile: cohort.boundaryProfile,
        },
        cohort,
      ),
    ).toBe(true)
  })

  it('rejects v3 records with a different boundary profile', () => {
    expect(
      matchesAuditCohort(
        {
          runtimeArtifactHash: cohort.runtimeArtifactHash,
          decisionConfigFingerprint: cohort.decisionConfigFingerprint,
          boundaryProfile: 'l1-full-recommended',
        },
        cohort,
      ),
    ).toBe(false)
  })

  it('rejects partial v3 records instead of falling back to legacy identity', () => {
    expect(
      matchesAuditCohort(
        {
          runtimeArtifactHash: cohort.runtimeArtifactHash,
          runtimeBuildStamp: cohort.runtimeBuildStamp,
          configFingerprint: cohort.configFingerprint,
        },
        cohort,
      ),
    ).toBe(false)
    expect(
      matchesAuditCohort(
        {
          decisionConfigFingerprint: cohort.decisionConfigFingerprint,
          runtimeBuildStamp: cohort.runtimeBuildStamp,
          configFingerprint: cohort.configFingerprint,
        },
        cohort,
      ),
    ).toBe(false)
  })

  it('matches legacy records when v3 fields are absent', () => {
    expect(
      matchesAuditCohort(
        {
          runtimeBuildStamp: cohort.runtimeBuildStamp,
          configFingerprint: cohort.configFingerprint,
        },
        cohort,
      ),
    ).toBe(true)
  })

  it('rejects invalid runtimeArtifactHash values on the v3 path', () => {
    expect(
      matchesAuditCohort(
        {
          runtimeArtifactHash: 'abc123deadbeef',
          decisionConfigFingerprint: cohort.decisionConfigFingerprint,
        },
        cohort,
      ),
    ).toBe(false)
  })
})
