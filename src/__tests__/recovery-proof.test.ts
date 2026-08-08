import { describe, expect, it } from 'vitest'

import type { CapabilityRequestV1 } from '../core/capability/request.js'
import { capabilityRequestsBlockRecovery } from '../core/recovery/capability.js'
import {
  recoveryFailClosedResult,
  recoveryFailReasonFromSkip,
} from '../core/recovery/fail-closed.js'

function shellRequest(action: CapabilityRequestV1['action']): CapabilityRequestV1 {
  return {
    version: 1,
    principal: { repoRoot: '/workspace/project' },
    action,
    resource: { kind: 'path', path: '/workspace/project/notes.txt' },
    context: {
      cwd: '/workspace/project',
      inputFingerprint: 'fp',
      hookKind: 'shell',
      analysisBasis: [],
    },
    evidence: { level: 'certain', signals: [] },
  }
}

describe('recovery capability guards', () => {
  it('blocks recovery when network.connect is present', () => {
    expect(capabilityRequestsBlockRecovery([shellRequest('network.connect')])).toBe(true)
  })

  it('allows recovery for local fs.write requests', () => {
    expect(capabilityRequestsBlockRecovery([shellRequest('fs.write')])).toBe(false)
  })

  it('recoveryFailClosed upgrades allow_flagged to deny_pending_approval', () => {
    const predicted = {
      verdict: 'allow_flagged' as const,
      reason: 'local_mutation',
      fingerprint: 'fp',
      summary: 'touch notes.txt',
      assessment: {
        reversibility: 'recoverable_with_cost' as const,
        external: false,
        blastRadius: 'this repository',
        confidence: 0.75,
        signals: ['repo_local_mutation'],
      },
    }
    const closed = recoveryFailClosedResult(predicted, 'recovery_substrate_unavailable', [
      'dirty_worktree',
    ])
    expect(closed.verdict).toBe('deny_pending_approval')
    expect(closed.reason).toBe('recovery_substrate_unavailable')
    expect(closed.assessment.signals).toContain('recovery_fail_closed')
  })

  it('recoveryFailReasonFromSkip maps skip reasons to distinct fail reasons', () => {
    expect(recoveryFailReasonFromSkip('dirty_worktree')).toBe('recovery_dirty_worktree')
    expect(recoveryFailReasonFromSkip('git_worktree_unavailable')).toBe(
      'recovery_substrate_unavailable',
    )
    expect(recoveryFailReasonFromSkip('transactional_command_failed')).toBe(
      'recovery_execution_failed',
    )
    expect(recoveryFailReasonFromSkip('transactional_timed_out')).toBe('recovery_execution_failed')
  })
})
