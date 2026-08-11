import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'
import { recordApproval } from '../core/approval-service.js'
import { issueApprovalToken } from '../core/approval-token.js'
import { DEFAULT_CONFIG_V3 } from '../core/config.js'
import type { ApprovalStateFile } from '../core/types.js'

const tempDirs: string[] = []

function memoryStore(
  pending: ApprovalStateFile,
  approved: ApprovalStateFile = { version: 1, approvals: [] },
) {
  return {
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

describe('recordApproval', () => {
  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
  })

  it('allows editor path without token even when signing is required', async () => {
    const pending: ApprovalStateFile = {
      version: 1,
      approvals: [
        {
          approvalId: 'belay_editor',
          kind: 'shell',
          fingerprint: 'fp1',
          repoRoot: '/repo',
          reason: 'external_effect',
          summary: 'git push',
          createdAt: new Date().toISOString(),
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        },
      ],
    }

    const result = await recordApproval({
      approvalId: 'belay_editor',
      config: { ...DEFAULT_CONFIG_V3, approvalSigning: { required: true } },
      requireSignedToken: false,
      store: memoryStore(pending),
    })

    expect(result.ok).toBe(true)
    expect(pending.approvals).toHaveLength(0)
  })

  it('requires and binds signed token for out-of-band approval', async () => {
    const controlPlaneDir = await mkdtemp(path.join(os.tmpdir(), 'belay-approval-svc-'))
    tempDirs.push(controlPlaneDir)
    const repoRoot = '/repo'
    const pending: ApprovalStateFile = {
      version: 1,
      approvals: [
        {
          approvalId: 'belay_oob',
          kind: 'shell',
          fingerprint: 'fp1',
          repoRoot,
          reason: 'external_effect',
          summary: 'git push',
          createdAt: new Date().toISOString(),
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        },
      ],
    }

    const config = {
      ...DEFAULT_CONFIG_V3,
      approvalSigning: { required: true },
      controlPlane: { ...DEFAULT_CONFIG_V3.controlPlane, configDir: controlPlaneDir },
    }

    const approval = pending.approvals[0]
    expect(approval).toBeDefined()

    const token = await issueApprovalToken(
      {
        approvalId: 'belay_oob',
        fingerprint: 'fp1',
        repoRoot,
        issuedAt: approval.createdAt,
        expiresAt: approval.expiresAt,
      },
      controlPlaneDir,
    )

    const result = await recordApproval({
      approvalId: 'belay_oob',
      config,
      token,
      requireSignedToken: true,
      store: memoryStore(pending),
    })
    expect(result.ok).toBe(true)
  })

  it('rejects signed token when fingerprint does not match pending approval', async () => {
    const controlPlaneDir = await mkdtemp(path.join(os.tmpdir(), 'belay-approval-svc-'))
    tempDirs.push(controlPlaneDir)
    const repoRoot = '/repo'
    const pending: ApprovalStateFile = {
      version: 1,
      approvals: [
        {
          approvalId: 'belay_oob',
          kind: 'shell',
          fingerprint: 'fp1',
          repoRoot,
          reason: 'external_effect',
          summary: 'git push',
          createdAt: new Date().toISOString(),
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        },
      ],
    }

    const config = {
      ...DEFAULT_CONFIG_V3,
      approvalSigning: { required: true },
      controlPlane: { ...DEFAULT_CONFIG_V3.controlPlane, configDir: controlPlaneDir },
    }

    const approval = pending.approvals[0]
    expect(approval).toBeDefined()

    const mismatched = await issueApprovalToken(
      {
        approvalId: 'belay_oob',
        fingerprint: 'other-fp',
        repoRoot,
        issuedAt: approval.createdAt,
        expiresAt: approval.expiresAt,
      },
      controlPlaneDir,
    )

    const rejected = await recordApproval({
      approvalId: 'belay_oob',
      config,
      token: mismatched,
      requireSignedToken: true,
      store: memoryStore(pending),
    })
    expect(rejected.ok).toBe(false)
    expect(rejected.message).toContain('does not match')
  })

  it('does not restore a consumed approval when recording races with consumption', async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), 'belay-approval-race-'))
    tempDirs.push(stateDir)
    const expiresAt = new Date(Date.now() + 60_000).toISOString()
    let pending: ApprovalStateFile = {
      version: 3,
      revision: 0,
      approvals: [
        {
          approvalId: 'belay_new',
          kind: 'shell',
          fingerprint: 'fp-new',
          repoRoot: '/repo',
          reason: 'external_effect',
          summary: 'git push',
          createdAt: new Date().toISOString(),
          expiresAt,
        },
      ],
    }
    const staleApproved: ApprovalStateFile = {
      version: 3,
      revision: 0,
      approvals: [
        {
          approvalId: 'belay_consumed',
          kind: 'shell',
          fingerprint: 'fp-old',
          repoRoot: '/repo',
          reason: 'external_effect',
          summary: 'git push',
          createdAt: new Date().toISOString(),
          expiresAt,
          approvedAt: new Date().toISOString(),
        },
      ],
    }
    let approved: ApprovalStateFile = { version: 3, revision: 1, approvals: [] }
    let approvedLoads = 0
    const clone = (state: ApprovalStateFile): ApprovalStateFile => structuredClone(state)
    const store = {
      async loadPending() {
        return { filePath: path.join(stateDir, 'pending.json'), state: clone(pending) }
      },
      async loadApproved() {
        approvedLoads += 1
        return {
          filePath: path.join(stateDir, 'approved.json'),
          state: clone(approvedLoads === 1 ? staleApproved : approved),
        }
      },
      async writePending(_filePath: string, state: ApprovalStateFile) {
        pending = clone(state)
      },
      async writeApproved(_filePath: string, state: ApprovalStateFile) {
        approved = clone(state)
      },
    }

    const result = await recordApproval({
      approvalId: 'belay_new',
      config: DEFAULT_CONFIG_V3,
      store,
    })

    expect(result.ok).toBe(true)
    expect(approved.approvals.map((approval) => approval.approvalId)).toEqual(['belay_new'])
    expect(approved.revision).toBe(2)
  })

  it('records only one grant when the same approval is recorded concurrently', async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), 'belay-approval-claim-race-'))
    tempDirs.push(stateDir)
    let pending: ApprovalStateFile = {
      version: 3,
      revision: 0,
      approvals: [
        {
          approvalId: 'belay_once',
          kind: 'shell',
          fingerprint: 'fp-once',
          repoRoot: '/repo',
          reason: 'external_effect',
          summary: 'git push',
          createdAt: new Date().toISOString(),
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        },
      ],
    }
    let approved: ApprovalStateFile = { version: 3, revision: 0, approvals: [] }
    let initialPendingLoads = 0
    let releaseInitialLoads: (() => void) | undefined
    const initialLoadsReady = new Promise<void>((resolve) => {
      releaseInitialLoads = resolve
    })
    const clone = (state: ApprovalStateFile): ApprovalStateFile => structuredClone(state)
    const store = {
      async loadPending() {
        const loaded = clone(pending)
        if (initialPendingLoads < 2) {
          initialPendingLoads += 1
          if (initialPendingLoads === 2) {
            releaseInitialLoads?.()
          }
          await initialLoadsReady
        }
        return { filePath: path.join(stateDir, 'pending.json'), state: loaded }
      },
      async loadApproved() {
        return { filePath: path.join(stateDir, 'approved.json'), state: clone(approved) }
      },
      async writePending(_filePath: string, state: ApprovalStateFile) {
        pending = clone(state)
      },
      async writeApproved(_filePath: string, state: ApprovalStateFile) {
        approved = clone(state)
      },
    }

    const results = await Promise.all(
      Array.from({ length: 2 }, () =>
        recordApproval({ approvalId: 'belay_once', config: DEFAULT_CONFIG_V3, store }),
      ),
    )

    expect(results.every((result) => result.ok)).toBe(true)
    expect(pending.approvals).toEqual([])
    expect(approved.approvals.map((approval) => approval.approvalId)).toEqual(['belay_once'])
  })

  it('preserves separate approvals recorded concurrently', async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), 'belay-approval-concurrent-'))
    tempDirs.push(stateDir)
    const expiresAt = new Date(Date.now() + 60_000).toISOString()
    let pending: ApprovalStateFile = {
      version: 3,
      revision: 0,
      approvals: ['first', 'second'].map((suffix) => ({
        approvalId: `belay_${suffix}`,
        kind: 'shell' as const,
        fingerprint: `fp-${suffix}`,
        repoRoot: '/repo',
        reason: 'external_effect',
        summary: 'git push',
        createdAt: new Date().toISOString(),
        expiresAt,
      })),
    }
    let approved: ApprovalStateFile = { version: 3, revision: 0, approvals: [] }
    let initialApprovedLoads = 0
    let releaseInitialLoads: (() => void) | undefined
    const initialLoadsReady = new Promise<void>((resolve) => {
      releaseInitialLoads = resolve
    })
    const clone = (state: ApprovalStateFile): ApprovalStateFile => structuredClone(state)
    const store = {
      async loadPending() {
        return { filePath: path.join(stateDir, 'pending.json'), state: clone(pending) }
      },
      async loadApproved() {
        if (initialApprovedLoads < 2) {
          initialApprovedLoads += 1
          if (initialApprovedLoads === 2) {
            releaseInitialLoads?.()
          }
          await initialLoadsReady
        }
        return { filePath: path.join(stateDir, 'approved.json'), state: clone(approved) }
      },
      async writePending(_filePath: string, state: ApprovalStateFile) {
        pending = clone(state)
      },
      async writeApproved(_filePath: string, state: ApprovalStateFile) {
        approved = clone(state)
      },
    }

    const results = await Promise.all(
      ['belay_first', 'belay_second'].map((approvalId) =>
        recordApproval({ approvalId, config: DEFAULT_CONFIG_V3, store }),
      ),
    )

    expect(results.every((result) => result.ok)).toBe(true)
    expect(pending.approvals).toEqual([])
    expect(approved.approvals.map((approval) => approval.approvalId).sort()).toEqual([
      'belay_first',
      'belay_second',
    ])
  })

  it('retires pending state before publishing and makes a persisted partial write retryable', async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), 'belay-approval-partial-write-'))
    tempDirs.push(stateDir)
    let pending: ApprovalStateFile = {
      version: 3,
      revision: 0,
      approvals: [
        {
          approvalId: 'belay_partial',
          kind: 'shell',
          fingerprint: 'fp-partial',
          repoRoot: '/repo',
          reason: 'external_effect',
          summary: 'git push',
          createdAt: new Date().toISOString(),
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        },
      ],
    }
    let approved: ApprovalStateFile = { version: 3, revision: 0, approvals: [] }
    const clone = (state: ApprovalStateFile): ApprovalStateFile => structuredClone(state)
    const store = {
      async loadPending() {
        return { filePath: path.join(stateDir, 'pending.json'), state: clone(pending) }
      },
      async loadApproved() {
        return { filePath: path.join(stateDir, 'approved.json'), state: clone(approved) }
      },
      async writePending(_filePath: string, state: ApprovalStateFile) {
        pending = clone(state)
      },
      async writeApproved(_filePath: string, state: ApprovalStateFile) {
        approved = clone(state)
        throw new Error('simulated approved-state persistence failure')
      },
    }

    await expect(
      recordApproval({ approvalId: 'belay_partial', config: DEFAULT_CONFIG_V3, store }),
    ).rejects.toThrow('simulated approved-state persistence failure')

    expect(pending.approvals).toEqual([])
    expect(approved.approvals.map((approval) => approval.approvalId)).toEqual(['belay_partial'])

    const retry = await recordApproval({
      approvalId: 'belay_partial',
      config: DEFAULT_CONFIG_V3,
      store,
    })
    expect(retry.ok).toBe(true)
    expect(approved.approvals.map((approval) => approval.approvalId)).toEqual(['belay_partial'])
  })
})
