import { afterEach, describe, expect, it, vi } from 'vitest'
import * as approvalReplay from '../core/approval-replay.js'
import { consumeApprovedAfterCliReplay, recordApproval } from '../core/approval-service.js'
import { DEFAULT_CONFIG_V4 } from '../core/config.js'
import type { ApprovalStateFile } from '../core/types.js'

function memoryStore(
  pending: ApprovalStateFile,
  approved: ApprovalStateFile = { version: 2, approvals: [] },
) {
  return {
    async loadPending() {
      return { filePath: '/tmp/pending.json', state: pending }
    },
    async loadApproved() {
      return { filePath: '/tmp/approved.json', state: approved }
    },
    async writePending(_filePath: string, state: ApprovalStateFile) {
      pending.approvals = state.approvals
      pending.version = state.version
    },
    async writeApproved(_filePath: string, state: ApprovalStateFile) {
      approved.approvals = state.approvals
      approved.version = state.version
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

    const replayResult = await approvalReplay.replayShellCommand('echo ok', '/repo')
    expect(replayResult.exitCode).toBe(0)

    await consumeApprovedAfterCliReplay({ approvalId: 'belay_replay01', store })
    expect(approved.approvals).toHaveLength(0)
  })

  it('keeps approved grant when CLI replay fails', async () => {
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

    vi.spyOn(approvalReplay, 'replayShellCommand').mockResolvedValue({
      exitCode: 1,
      stdout: '',
      stderr: 'failed',
    })

    const replayResult = await approvalReplay.replayShellCommand('false', '/repo')
    expect(replayResult.exitCode).toBe(1)
    expect(approved.approvals).toHaveLength(1)
  })
})
