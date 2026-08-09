import { afterEach, describe, expect, it, vi } from 'vitest'
import * as approvalReplay from '../core/approval-replay.js'
import { claimApprovedForReplay, recordApproval } from '../core/approval-service.js'
import { DEFAULT_CONFIG_V4 } from '../core/config.js'
import type { ApprovalStateFile } from '../core/types.js'

function memoryStore(
  pending: ApprovalStateFile,
  approved: ApprovalStateFile = { version: 2, approvals: [] },
) {
  const storeId = `${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`
  return {
    async loadPending() {
      return { filePath: `/tmp/pending-${storeId}.json`, state: pending }
    },
    async loadApproved() {
      return { filePath: `/tmp/approved-${storeId}.json`, state: approved }
    },
    async writePending(_filePath: string, state: ApprovalStateFile) {
      pending.approvals = state.approvals
      pending.version = state.version
      pending.revision = state.revision
    },
    async writeApproved(_filePath: string, state: ApprovalStateFile) {
      approved.approvals = state.approvals
      approved.version = state.version
      approved.revision = state.revision
    },
  }
}

describe('approve --replay consumption', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('removes approved grant after successful CLI replay', async () => {
    const pending: ApprovalStateFile = {
      version: 2,
      approvals: [
        {
          approvalId: 'belay_replay01',
          kind: 'shell',
          fingerprint: 'fp1',
          repoRoot: '/repo',
          reason: 'external_effect',
          summary: 'echo ok',
          input: 'echo ok',
          inputKind: 'shell',
          cwd: '/repo',
          createdAt: new Date().toISOString(),
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        },
      ],
    }
    const approved: ApprovalStateFile = { version: 2, approvals: [] }
    const store = memoryStore(pending, approved)

    const recorded = await recordApproval({
      approvalId: 'belay_replay01',
      config: DEFAULT_CONFIG_V4,
      store,
    })
    expect(recorded.ok).toBe(true)
    expect(approved.approvals).toHaveLength(1)

    vi.spyOn(approvalReplay, 'replayShellCommand').mockResolvedValue({
      exitCode: 0,
      stdout: 'ok\n',
      stderr: '',
    })

    const claimed = await claimApprovedForReplay({ approvalId: 'belay_replay01', store })
    expect(claimed?.approvalId).toBe('belay_replay01')
    expect(approved.approvals).toHaveLength(0)

    const replayResult = await approvalReplay.replayShellCommand('echo ok', '/repo')
    expect(replayResult.exitCode).toBe(0)
  })

  it('allows only one concurrent claim for the same approved grant', async () => {
    const pending: ApprovalStateFile = {
      version: 2,
      approvals: [
        {
          approvalId: 'belay_replay02',
          kind: 'shell',
          fingerprint: 'fp2',
          repoRoot: '/repo',
          reason: 'external_effect',
          summary: 'false',
          input: 'false',
          inputKind: 'shell',
          cwd: '/repo',
          createdAt: new Date().toISOString(),
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        },
      ],
    }
    const approved: ApprovalStateFile = { version: 2, approvals: [] }
    const store = memoryStore(pending, approved)

    await recordApproval({
      approvalId: 'belay_replay02',
      config: DEFAULT_CONFIG_V4,
      store,
    })
    expect(approved.approvals).toHaveLength(1)

    const claims = await Promise.all([
      claimApprovedForReplay({ approvalId: 'belay_replay02', store }),
      claimApprovedForReplay({ approvalId: 'belay_replay02', store }),
    ])
    expect(claims.filter(Boolean)).toHaveLength(1)
    expect(approved.approvals).toHaveLength(0)
  })
})
