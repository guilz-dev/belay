import { describe, expect, it } from 'vitest'
import { toAuditRecord } from '../core/audit-metrics.js'
import {
  recordToRecoverTarget,
  recoverCandidatePriority,
  selectRecoverTarget,
} from '../core/recover-select.js'

describe('recover-select', () => {
  it('ranks allow(local_mutation) above ask(external)', () => {
    const localAllow = toAuditRecord({
      timestamp: '2026-06-01T12:00:00.000Z',
      event: 'beforeShellExecution',
      verdict: 'allow',
      permission: 'allow',
      effect: 'local_mutation',
      summary: 'rm src/important.ts',
      fingerprint: 'fp-local',
    })
    const externalAsk = toAuditRecord({
      timestamp: '2026-06-02T12:00:00.000Z',
      event: 'beforeShellExecution',
      verdict: 'deny_pending_approval',
      wouldBlock: true,
      effect: 'external_effect',
      summary: 'docker push',
      fingerprint: 'fp-external',
    })

    expect(recoverCandidatePriority(localAllow)).toBeLessThan(recoverCandidatePriority(externalAsk))
    expect(selectRecoverTarget([externalAsk, localAllow])?.fingerprint).toBe('fp-local')
  })

  it('prefers blocked local_mutation over newer external ask', () => {
    const externalAsk = toAuditRecord({
      timestamp: '2026-06-03T12:00:00.000Z',
      event: 'beforeShellExecution',
      verdict: 'deny_pending_approval',
      wouldBlock: true,
      effect: 'external_effect',
      fingerprint: 'fp-external-newer',
    })
    const blockedLocal = toAuditRecord({
      timestamp: '2026-06-02T12:00:00.000Z',
      event: 'beforeShellExecution',
      verdict: 'deny_pending_approval',
      wouldBlock: true,
      effect: 'local_mutation',
      fingerprint: 'fp-blocked-local',
    })

    expect(selectRecoverTarget([externalAsk, blockedLocal])?.fingerprint).toBe('fp-blocked-local')
  })

  it('maps audit records to recover targets', () => {
    const record = toAuditRecord({
      timestamp: '2026-06-01T12:00:00.000Z',
      event: 'beforeShellExecution',
      verdict: 'allow',
      effect: 'local_mutation',
      reason: 'local_mutation',
      summary: 'rm file.txt',
      fingerprint: 'fp-map',
      location: 'repo',
      permission: 'allow',
    })

    expect(recordToRecoverTarget(record)).toEqual({
      timestamp: '2026-06-01T12:00:00.000Z',
      fingerprint: 'fp-map',
      summary: 'rm file.txt',
      reason: 'local_mutation',
      effect: 'local_mutation',
      location: 'repo',
      permission: 'allow',
      assessment: undefined,
    })
  })
})
