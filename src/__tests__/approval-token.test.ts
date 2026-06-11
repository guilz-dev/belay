import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { issueApprovalToken, verifyApprovalToken } from '../core/approval-token.js'

const tempDirs: string[] = []

describe('approval-token', () => {
  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
  })

  it('issues and verifies signed approval tokens', async () => {
    const controlPlaneDir = await mkdtemp(path.join(os.tmpdir(), 'belay-token-'))
    tempDirs.push(controlPlaneDir)

    const token = await issueApprovalToken(
      {
        approvalId: 'belay_test123',
        fingerprint: 'fp',
        repoRoot: '/repo',
        issuedAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      },
      controlPlaneDir,
    )

    const verified = await verifyApprovalToken(token, controlPlaneDir)
    expect(verified?.approvalId).toBe('belay_test123')
  })

  it('rejects tampered tokens', async () => {
    const controlPlaneDir = await mkdtemp(path.join(os.tmpdir(), 'belay-token-'))
    tempDirs.push(controlPlaneDir)

    const token = await issueApprovalToken(
      {
        approvalId: 'belay_test123',
        fingerprint: 'fp',
        repoRoot: '/repo',
        issuedAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      },
      controlPlaneDir,
    )

    const verified = await verifyApprovalToken(`${token}x`, controlPlaneDir)
    expect(verified).toBeNull()
  })
})
