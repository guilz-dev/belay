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
      pending.approvals = state.approvals
    },
    async writeApproved(_filePath: string, state: ApprovalStateFile) {
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

    const token = await issueApprovalToken(
      {
        approvalId: 'belay_oob',
        fingerprint: 'fp1',
        repoRoot,
        issuedAt: pending.approvals[0]!.createdAt,
        expiresAt: pending.approvals[0]!.expiresAt,
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

    const mismatched = await issueApprovalToken(
      {
        approvalId: 'belay_oob',
        fingerprint: 'other-fp',
        repoRoot,
        issuedAt: pending.approvals[0]!.createdAt,
        expiresAt: pending.approvals[0]!.expiresAt,
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
})
