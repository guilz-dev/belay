import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
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
  trustedRootsPath: string,
) {
  return {
    allowlistPath,
    trustedRootsPath,
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
    const trustedRootsPath = path.join(path.dirname(allowlistPath), 'trusted-workspace-roots.json')
    tempDirs.push(path.dirname(allowlistPath))

    const result = await recordCapabilityApproval({
      approvalId: 'belay_wrongreason',
      config: DEFAULT_CONFIG_V3,
      store: memoryStore(pending, approved, allowlistPath, trustedRootsPath),
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
    const trustedRootsPath = path.join(stateDir, 'trusted-workspace-roots.json')
    const outsidePath = canonicalPath('/tmp/outside.txt')

    const result = await recordCapabilityApproval({
      approvalId: 'belay_outside',
      config: DEFAULT_CONFIG_V3,
      store: memoryStore(pending, approved, allowlistPath, trustedRootsPath),
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

  it('adds a trusted workspace root when scope hint matches', async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), 'belay-cap-trusted-'))
    tempDirs.push(stateDir)
    const trustedRoot = path.join(stateDir, 'cursor-plans')
    await mkdir(trustedRoot, { recursive: true })
    const pending: ApprovalStateFile = {
      version: 2,
      approvals: [
        {
          approvalId: 'belay_workspace_root',
          kind: 'tool',
          fingerprint: 'fp',
          repoRoot: '/repo',
          reason: 'outside_repo_mutation',
          summary: 'write plan',
          createdAt: new Date().toISOString(),
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
          scopeHint: { scope: 'workspace-root', path: trustedRoot },
        },
      ],
    }
    const approved: ApprovalStateFile = { version: 1, approvals: [] }
    const allowlistPath = path.join(stateDir, 'fs-scope-allowlist.json')
    const trustedRootsPath = path.join(stateDir, 'trusted-workspace-roots.json')

    const result = await recordCapabilityApproval({
      approvalId: 'belay_workspace_root',
      config: DEFAULT_CONFIG_V3,
      store: memoryStore(pending, approved, allowlistPath, trustedRootsPath),
      scope: 'workspace-root',
      scopePath: trustedRoot,
    })

    expect(result.ok).toBe(true)
    const saved = JSON.parse(await readFile(trustedRootsPath, 'utf8')) as {
      roots: Array<{ path: string; approvalId: string }>
    }
    expect(saved.roots).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: canonicalPath(trustedRoot),
          approvalId: 'belay_workspace_root',
        }),
      ]),
    )
  })

  it('rejects workspace-root approval when path does not match scope hint', async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), 'belay-cap-trusted-'))
    tempDirs.push(stateDir)
    const trustedRoot = path.join(stateDir, 'cursor-plans')
    const differentRoot = path.join(stateDir, 'other')
    await mkdir(trustedRoot, { recursive: true })
    await mkdir(differentRoot, { recursive: true })
    const pending: ApprovalStateFile = {
      version: 2,
      approvals: [
        {
          approvalId: 'belay_workspace_root_mismatch',
          kind: 'tool',
          fingerprint: 'fp',
          repoRoot: '/repo',
          reason: 'outside_repo_mutation',
          summary: 'write plan',
          createdAt: new Date().toISOString(),
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
          scopeHint: { scope: 'workspace-root', path: trustedRoot },
        },
      ],
    }
    const approved: ApprovalStateFile = { version: 1, approvals: [] }
    const allowlistPath = path.join(stateDir, 'fs-scope-allowlist.json')
    const trustedRootsPath = path.join(stateDir, 'trusted-workspace-roots.json')

    const result = await recordCapabilityApproval({
      approvalId: 'belay_workspace_root_mismatch',
      config: DEFAULT_CONFIG_V3,
      store: memoryStore(pending, approved, allowlistPath, trustedRootsPath),
      scope: 'workspace-root',
      scopePath: differentRoot,
    })

    expect(result.ok).toBe(false)
    expect(result.message).toContain('must exactly match')
  })

  it('rejects workspace-root approval for high-stakes directories', async () => {
    const pending: ApprovalStateFile = {
      version: 2,
      approvals: [
        {
          approvalId: 'belay_workspace_root_high_stakes',
          kind: 'tool',
          fingerprint: 'fp',
          repoRoot: '/repo',
          reason: 'outside_repo_mutation',
          summary: 'write hosts',
          createdAt: new Date().toISOString(),
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
          scopeHint: { scope: 'workspace-root', path: '/etc' },
        },
      ],
    }
    const approved: ApprovalStateFile = { version: 1, approvals: [] }
    const stateDir = await mkdtemp(path.join(os.tmpdir(), 'belay-cap-trusted-'))
    tempDirs.push(stateDir)
    const allowlistPath = path.join(stateDir, 'fs-scope-allowlist.json')
    const trustedRootsPath = path.join(stateDir, 'trusted-workspace-roots.json')

    const result = await recordCapabilityApproval({
      approvalId: 'belay_workspace_root_high_stakes',
      config: DEFAULT_CONFIG_V3,
      store: memoryStore(pending, approved, allowlistPath, trustedRootsPath),
      scope: 'workspace-root',
      scopePath: '/etc',
    })

    expect(result.ok).toBe(false)
    expect(result.message).toContain('high-stakes')
  })
})
