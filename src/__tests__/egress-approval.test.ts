import { describe, expect, it } from 'vitest'

import { DEFAULT_CONFIG_V3 } from '../core/config.js'
import { recordEgressApproval } from '../core/egress-approval.js'
import type { ApprovalStateFile } from '../core/types.js'

function memoryStore(
  pending: ApprovalStateFile,
  approved: ApprovalStateFile,
  allowlistPath: string,
) {
  return {
    allowlistPath,
    async loadPending() {
      return { filePath: '/tmp/pending.json', state: pending }
    },
    async loadApproved() {
      return { filePath: '/tmp/approved.json', state: approved }
    },
    async writePending(_filePath: string, state: ApprovalStateFile) {
      pending.approvals = state.approvals
    },
    async writeApproved(_filePath: string, state: ApprovalStateFile) {
      approved.approvals = state.approvals
    },
  }
}

describe('recordEgressApproval', () => {
  it('fails domain scope when host cannot be parsed from summary', async () => {
    const pending: ApprovalStateFile = {
      version: 1,
      approvals: [
        {
          approvalId: 'belay_badsummary',
          kind: 'egress',
          fingerprint: 'fp',
          repoRoot: '/repo',
          reason: 'egress_blocked',
          summary: 'blocked connection',
          createdAt: new Date().toISOString(),
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        },
      ],
    }
    const approved: ApprovalStateFile = { version: 1, approvals: [] }

    const result = await recordEgressApproval({
      approvalId: 'belay_badsummary',
      config: DEFAULT_CONFIG_V3,
      store: memoryStore(pending, approved, '/tmp/allowlist.json'),
      scope: 'domain',
    })

    expect(result.ok).toBe(false)
    expect(result.message).toContain('Cannot add domain')
    expect(approved.approvals).toHaveLength(0)
  })
})
