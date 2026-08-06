import { describe, expect, it } from 'vitest'

import { evaluateGuaranteePosture } from '../../conformance/guarantee-posture.js'
import { DEFAULT_CONFIG_V4 } from '../../core/config.js'

describe('guarantee posture', () => {
  it('separates configured L1-full from attested L3-only when attestation is missing', () => {
    const config = {
      ...DEFAULT_CONFIG_V4,
      version: 5 as const,
      sandbox: { ...DEFAULT_CONFIG_V4.sandbox, enabled: true, runtime: 'container' as const },
      egress: { ...DEFAULT_CONFIG_V4.egress, enabled: true },
      approvalSigning: { required: true },
      controlPlane: {
        ...DEFAULT_CONFIG_V4.controlPlane,
        isolation: { mode: 'separate-user' as const, verifyAgentWritable: true },
      },
    }
    const posture = evaluateGuaranteePosture({
      config,
      attestation: null,
      egressProxyRunning: true,
    })
    expect(posture.configuredProfile).toBe('l1-full')
    expect(posture.attestedProfile).toBe('l3-l4-only')
    expect(posture.postureMismatch).toBe(true)
  })

  it('aligns configured and attested profiles with fresh container attestation', () => {
    const config = {
      ...DEFAULT_CONFIG_V4,
      version: 5 as const,
      sandbox: { ...DEFAULT_CONFIG_V4.sandbox, enabled: true, runtime: 'container' as const },
      egress: { ...DEFAULT_CONFIG_V4.egress, enabled: true },
      approvalSigning: { required: true },
      controlPlane: {
        ...DEFAULT_CONFIG_V4.controlPlane,
        isolation: { mode: 'separate-user' as const, verifyAgentWritable: true },
      },
    }
    const posture = evaluateGuaranteePosture({
      config,
      attestation: {
        version: 1,
        driver: 'container',
        probedAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        deniesUngrantedEffects: true,
        materializesGrants: true,
        probeSignals: ['docker'],
      },
      egressProxyRunning: true,
    })
    expect(posture.configuredProfile).toBe('l1-full')
    expect(posture.attestedProfile).toBe('l1-full')
    expect(posture.postureMismatch).toBe(false)
    expect(posture.l1FullAttested).toBe(true)
  })
})
