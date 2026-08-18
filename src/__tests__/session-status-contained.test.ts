import { describe, expect, it } from 'vitest'

import { formatSessionStatusReport, sessionStatusOk } from '../commands/session.js'

describe('contained session status display', () => {
  it('accepts either generic freshness or compatible contained freshness', () => {
    expect(sessionStatusOk({ fresh: true })).toBe(true)
    expect(sessionStatusOk({ fresh: false, containedExecutionFresh: true })).toBe(true)
    expect(sessionStatusOk({ fresh: false, containedExecutionFresh: false })).toBe(false)
    expect(sessionStatusOk({ fresh: false })).toBe(false)
  })

  it('shows contained freshness separately from generic L1 freshness', () => {
    const report = formatSessionStatusReport({
      ok: true,
      attestationPath: '/repo/.belay/attestation.json',
      fresh: false,
      containedExecutionFresh: true,
      attestation: {
        version: 1,
        driver: 'container',
        probedAt: '2026-08-18T00:00:00.000Z',
        expiresAt: '2026-08-18T00:15:00.000Z',
        deniesUngrantedEffects: false,
        materializesGrants: false,
        probeSignals: [],
      },
    })
    expect(report).toContain('Fresh: no')
    expect(report).toContain('Contained execution fresh: yes')
  })

  it('keeps legacy and disabled session output unchanged', () => {
    const report = formatSessionStatusReport({
      ok: true,
      attestationPath: '/repo/.belay/attestation.json',
      fresh: true,
      attestation: {
        version: 1,
        driver: 'seatbelt',
        probedAt: '2026-08-18T00:00:00.000Z',
        expiresAt: '2026-08-18T00:15:00.000Z',
        deniesUngrantedEffects: true,
        materializesGrants: true,
        probeSignals: [],
      },
    })
    expect(report).toContain('Fresh: yes')
    expect(report).not.toContain('Contained execution fresh:')
  })
})
