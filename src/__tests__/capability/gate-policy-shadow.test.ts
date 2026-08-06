import { describe, expect, it } from 'vitest'

import { scheduleGateShadowAudit } from '../../core/capability/gate-policy-shadow.js'
import { DEFAULT_CONFIG_V4 } from '../../core/config.js'
import type { ClassifyResult } from '../../core/types.js'
import { normalizeJudgeRuntimeConfig } from '../../core/verdict/judge-runtime-config.js'

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
})
