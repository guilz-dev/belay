import { mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'
import { recordCapabilityApproval } from '../core/capability-approval.js'
import { DEFAULT_CONFIG_V3 } from '../core/config.js'
import { canonicalPath } from '../core/path-utils.js'
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
      pending.approvals = state.approvals
    },
    async writeApproved(_filePath: string, state: ApprovalStateFile) {
      approved.approvals = state.approvals
    },
  }
}

describe('recordCapabilityApproval', () => {
  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
  })

  it('rejects path scope for non outside-repo pending approvals', async () => {
    const pending: ApprovalStateFile = {
      version: 1,
      approvals: [
        {
          approvalId: 'belay_wrongreason',
          kind: 'shell',
          fingerprint: 'fp',
          repoRoot: '/repo',
          reason: 'destructive_command',
          summary: 'rm -rf /',
          createdAt: new Date().toISOString(),
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        },
      ],
    }
    const approved: ApprovalStateFile = { version: 1, approvals: [] }
    const allowlistPath = path.join(
      await mkdtemp(path.join(os.tmpdir(), 'belay-cap-')),
      'allowlist.json',
    )
    tempDirs.push(path.dirname(allowlistPath))

    const result = await recordCapabilityApproval({
      approvalId: 'belay_wrongreason',
      config: DEFAULT_CONFIG_V3,
      store: memoryStore(pending, approved, allowlistPath),
      scope: 'path',
      scopePath: '/tmp/outside.txt',
    })

    expect(result.ok).toBe(false)
    expect(result.message).toContain('outside-repo shell actions')
  })

  it('adds an approved path to the fs-scope allowlist', async () => {
    const pending: ApprovalStateFile = {
      version: 1,
      approvals: [
        {
          approvalId: 'belay_outside',
          kind: 'shell',
          fingerprint: 'fp',
          repoRoot: '/repo',
          reason: 'outside_repo_redirect',
          summary: 'echo hi > ../outside.txt',
          createdAt: new Date().toISOString(),
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        },
      ],
    }
    const approved: ApprovalStateFile = { version: 1, approvals: [] }
    const stateDir = await mkdtemp(path.join(os.tmpdir(), 'belay-cap-'))
    tempDirs.push(stateDir)
    const allowlistPath = path.join(stateDir, 'fs-scope-allowlist.json')
    const outsidePath = canonicalPath('/tmp/outside.txt')

    const result = await recordCapabilityApproval({
      approvalId: 'belay_outside',
      config: DEFAULT_CONFIG_V3,
      store: memoryStore(pending, approved, allowlistPath),
      scope: 'path',
      scopePath: '/tmp/outside.txt',
    })

    expect(result.ok).toBe(true)
    expect(result.message).toContain(outsidePath)
    expect(pending.approvals).toHaveLength(0)
    expect(approved.approvals).toHaveLength(1)
    const saved = JSON.parse(await readFile(allowlistPath, 'utf8')) as {
      paths: Array<{ path: string }>
    }
    expect(saved.paths.map((entry) => entry.path)).toContain(outsidePath)
  })
})
