import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { DEFAULT_CONFIG_V3 } from '../core/config.js'
import { loadEgressAllowlist } from '../core/egress/allowlist.js'
import { consumeApprovedEgress, recordEgressApproval } from '../core/egress-approval.js'
import type { ApprovalStateFile } from '../core/types.js'

const tempDirs: string[] = []

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
      pending.version = state.version
      pending.revision = state.revision
      pending.approvals = state.approvals
    },
    async writeApproved(_filePath: string, state: ApprovalStateFile) {
      approved.version = state.version
      approved.revision = state.revision
      approved.approvals = state.approvals
    },
  }
}

describe('recordEgressApproval', () => {
  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
  })

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

  it('does not consume an approval from a stale state snapshot', async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), 'belay-egress-race-'))
    tempDirs.push(stateDir)
    const stale: ApprovalStateFile = {
      version: 3,
      revision: 0,
      approvals: [
        {
          approvalId: 'belay_consumed',
          kind: 'egress',
          fingerprint: 'fp',
          repoRoot: '/repo',
          reason: 'egress_blocked',
          summary: 'POST example.com:443',
          createdAt: new Date().toISOString(),
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
          approvedAt: new Date().toISOString(),
        },
      ],
    }
    let current: ApprovalStateFile = { version: 3, revision: 1, approvals: [] }
    let approvedLoads = 0
    const clone = (state: ApprovalStateFile): ApprovalStateFile => structuredClone(state)
    const store = {
      allowlistPath: path.join(stateDir, 'allowlist.json'),
      async loadPending() {
        return {
          filePath: path.join(stateDir, 'pending.json'),
          state: { version: 3 as const, revision: 0, approvals: [] },
        }
      },
      async loadApproved() {
        approvedLoads += 1
        return {
          filePath: path.join(stateDir, 'approved.json'),
          state: clone(approvedLoads === 1 ? stale : current),
        }
      },
      async writePending() {},
      async writeApproved(_filePath: string, state: ApprovalStateFile) {
        current = clone(state)
      },
    }

    const consumed = await consumeApprovedEgress({
      repoRoot: '/repo',
      fingerprint: 'fp',
      store,
    })

    expect(consumed).toBeNull()
    expect(current).toEqual({ version: 3, revision: 1, approvals: [] })
  })

  it('reapplies domain scope idempotently after the approval was already recorded', async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), 'belay-egress-retry-'))
    tempDirs.push(stateDir)
    const pending: ApprovalStateFile = {
      version: 3,
      revision: 0,
      approvals: [
        {
          approvalId: 'belay_domain_retry',
          kind: 'egress',
          fingerprint: 'fp-domain-retry',
          repoRoot: '/repo',
          reason: 'egress_blocked',
          summary: 'POST retry.example.com:443',
          createdAt: new Date().toISOString(),
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        },
      ],
    }
    const approved: ApprovalStateFile = { version: 3, revision: 0, approvals: [] }
    const allowlistPath = path.join(stateDir, 'allowlist.json')
    const store = memoryStore(pending, approved, allowlistPath)

    const first = await recordEgressApproval({
      approvalId: 'belay_domain_retry',
      config: DEFAULT_CONFIG_V3,
      store,
      scope: 'domain',
    })
    const retry = await recordEgressApproval({
      approvalId: 'belay_domain_retry',
      config: DEFAULT_CONFIG_V3,
      store,
      scope: 'domain',
    })

    expect(first.ok).toBe(true)
    expect(retry.ok).toBe(true)
    expect((await loadEgressAllowlist(allowlistPath)).domains).toEqual([
      expect.objectContaining({ host: 'retry.example.com' }),
    ])
  })
})
