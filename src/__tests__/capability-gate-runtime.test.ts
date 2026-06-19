import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { cursorAdapter } from '../adapters/cursor/adapter.js'
import {
  createDefaultGateRuntimeDeps,
  evaluateGatedAction,
} from '../adapters/shared/gate-runtime.js'
import { createApprovalRecord } from '../core/approval.js'
import { fsScopeAllowlistPath } from '../core/capability/allowlist.js'
import { recordCapabilityApproval } from '../core/capability-approval.js'
import { type BelayConfigV3, DEFAULT_CONFIG_V3 } from '../core/config.js'
import { canonicalPath } from '../core/path-utils.js'
import { createCapabilityApprovalStore } from '../services/sandbox-service.js'
import { classifyShellGated } from './helpers/shell-classify.js'

const tempDirs: string[] = []

function sandboxBrokerConfig(): BelayConfigV3 {
  return {
    ...DEFAULT_CONFIG_V3,
    mode: 'enforce',
    policy: {
      ...DEFAULT_CONFIG_V3.policy,
      unknownLocalEffect: 'allow_flagged' as const,
    },
    sandbox: { ...DEFAULT_CONFIG_V3.sandbox, enabled: true, runtime: 'container' as const },
    controlPlane: {
      enabled: false,
      configDir: null,
      integrity: 'none' as const,
      isolation: { mode: 'none' as const, verifyAgentWritable: true },
    },
    audit: { logPath: '.cursor/belay/audit.ndjson', includeAssessment: true },
  }
}

describe('capability gate runtime', () => {
  beforeEach(() => {
    process.env.BELAY_DETERMINISTIC_JUDGE = '1'
  })

  afterEach(async () => {
    delete process.env.BELAY_DETERMINISTIC_JUDGE
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
  })

  it('allows allowlisted outside-repo redirects when the sandbox broker is active', async () => {
    const repoRoot = await mkdtemp(path.join(os.tmpdir(), 'belay-cap-gate-'))
    tempDirs.push(repoRoot)
    await mkdir(path.join(repoRoot, '.git'))
    const outsidePath = path.resolve(repoRoot, '..', 'outside.txt')
    const config = sandboxBrokerConfig()
    const stateDir = cursorAdapter.layout.repoLocalStateDir(repoRoot)
    await mkdir(stateDir, { recursive: true })
    await writeFile(
      fsScopeAllowlistPath(config, stateDir),
      `${JSON.stringify(
        {
          version: 1,
          paths: [
            {
              path: outsidePath,
              approvedAt: '2026-01-01T00:00:00.000Z',
              approvalId: 'belay_test',
            },
          ],
        },
        null,
        2,
      )}\n`,
    )

    const ctx = {
      layout: cursorAdapter.layout,
      repoRoot,
      config,
      configPath: cursorAdapter.layout.configPath(repoRoot),
    }
    const deps = createDefaultGateRuntimeDeps()
    const verdict = await evaluateGatedAction(ctx, deps, {
      kind: 'shell',
      cwd: repoRoot,
      command: 'echo hi > ../outside.txt',
    })

    expect(verdict.permission).toBe('allow')
    expect(verdict.reason).toBe('capability_fs_hint')
  })

  it('does not let one-shot approval bypass outside-repo rules when the broker is active', async () => {
    const repoRoot = await mkdtemp(path.join(os.tmpdir(), 'belay-cap-gate-'))
    tempDirs.push(repoRoot)
    await mkdir(path.join(repoRoot, '.git'))
    const config = sandboxBrokerConfig()
    const predicted = await classifyShellGated(
      'cp README.md ../copy.txt',
      repoRoot,
      repoRoot,
      config,
      { unknownLocalEffect: 'allow_flagged' },
    )
    expect(predicted.verdict).toBe('deny_pending_approval')
    expect(predicted.reason).toBe('outside_repo_mutation')
    const approval = createApprovalRecord({
      kind: 'shell',
      fingerprint: predicted.fingerprint,
      repoRoot,
      reason: predicted.reason,
      summary: predicted.normalizedCommand ?? '',
      approvalTtlMinutes: config.approvalTtlMinutes,
      approvalId: 'belay_testapproval',
    })
    approval.approvedAt = new Date().toISOString()

    const stateDir = cursorAdapter.layout.repoLocalStateDir(repoRoot)
    await mkdir(stateDir, { recursive: true })
    await writeFile(
      path.join(stateDir, 'approved-approvals.json'),
      `${JSON.stringify({ version: 1, approvals: [approval] }, null, 2)}\n`,
    )

    const ctx = {
      layout: cursorAdapter.layout,
      repoRoot,
      config,
      configPath: cursorAdapter.layout.configPath(repoRoot),
    }
    const deps = createDefaultGateRuntimeDeps()
    const verdict = await evaluateGatedAction(ctx, deps, {
      kind: 'shell',
      cwd: repoRoot,
      command: 'cp README.md ../copy.txt',
    })

    expect(verdict.permission).toBe('deny')
    expect(verdict.reason).toBe('outside_repo_mutation')
  })

  it('denies outside-repo Write tool mutations when the broker is active', async () => {
    const repoRoot = await mkdtemp(path.join(os.tmpdir(), 'belay-cap-gate-tool-'))
    tempDirs.push(repoRoot)
    await mkdir(path.join(repoRoot, '.git'))
    const config = sandboxBrokerConfig()
    const ctx = {
      layout: cursorAdapter.layout,
      repoRoot,
      config,
      configPath: cursorAdapter.layout.configPath(repoRoot),
    }
    const deps = createDefaultGateRuntimeDeps()
    const verdict = await evaluateGatedAction(ctx, deps, {
      kind: 'tool',
      cwd: repoRoot,
      payload: {
        tool_name: 'Write',
        tool_input: { path: '../outside.txt', contents: 'hi' },
      },
    })

    expect(verdict.permission).toBe('deny')
    expect(verdict.reason).toBe('outside_repo_mutation')
  })

  it('allows trusted workspace root tool mutations after scoped approval', async () => {
    const repoRoot = await mkdtemp(path.join(os.tmpdir(), 'belay-cap-gate-tool-'))
    tempDirs.push(repoRoot)
    await mkdir(path.join(repoRoot, '.git'))
    const trustedRoot = await mkdtemp(path.join(os.tmpdir(), 'belay-trusted-root-'))
    tempDirs.push(trustedRoot)
    const targetPath = path.join(trustedRoot, 'foo.plan.md')
    const config = sandboxBrokerConfig()
    const ctx = {
      layout: cursorAdapter.layout,
      repoRoot,
      config,
      configPath: cursorAdapter.layout.configPath(repoRoot),
    }
    const deps = createDefaultGateRuntimeDeps()

    const blocked = await evaluateGatedAction(ctx, deps, {
      kind: 'tool',
      cwd: repoRoot,
      payload: {
        tool_name: 'Write',
        tool_input: { path: targetPath, contents: 'hi' },
      },
    })
    expect(blocked.permission).toBe('deny')
    expect(blocked.reason).toBe('outside_repo_mutation')
    expect(blocked.approvalId).toMatch(/^belay_/)

    const stateDir = cursorAdapter.layout.repoLocalStateDir(repoRoot)
    const pendingPath = path.join(stateDir, 'pending-approvals.json')
    const pending = JSON.parse(await readFile(pendingPath, 'utf8')) as {
      approvals: Array<{
        approvalId: string
        scopeHint?: { scope: string; path: string }
      }>
    }
    const approval = pending.approvals.find((entry) => entry.approvalId === blocked.approvalId)
    expect(approval?.scopeHint).toEqual({
      scope: 'workspace-root',
      path: canonicalPath(trustedRoot),
    })
    const approvalId = blocked.approvalId
    expect(approvalId).toBeDefined()
    if (!approvalId) {
      throw new Error('approval id is required for workspace-root approval test')
    }

    const approved = await recordCapabilityApproval({
      approvalId,
      config,
      scope: 'workspace-root',
      scopePath: trustedRoot,
      store: createCapabilityApprovalStore(repoRoot, config),
    })
    expect(approved.ok).toBe(true)

    const verdict = await evaluateGatedAction(ctx, deps, {
      kind: 'tool',
      cwd: repoRoot,
      payload: {
        tool_name: 'Write',
        tool_input: { path: targetPath, contents: 'hi' },
      },
    })
    expect(verdict.permission).toBe('allow')
    expect(verdict.reason).toBe('file_mutation')
  })

  it('does not suggest workspace-root scope hints for high-stakes directories', async () => {
    const repoRoot = await mkdtemp(path.join(os.tmpdir(), 'belay-cap-gate-tool-'))
    tempDirs.push(repoRoot)
    await mkdir(path.join(repoRoot, '.git'))
    const config = sandboxBrokerConfig()
    const ctx = {
      layout: cursorAdapter.layout,
      repoRoot,
      config,
      configPath: cursorAdapter.layout.configPath(repoRoot),
    }
    const deps = createDefaultGateRuntimeDeps()
    const blocked = await evaluateGatedAction(ctx, deps, {
      kind: 'tool',
      cwd: repoRoot,
      payload: {
        tool_name: 'Write',
        tool_input: { path: '/etc/hosts', contents: 'hi' },
      },
    })
    expect(blocked.permission).toBe('deny')
    expect(blocked.reason).toBe('outside_repo_mutation')
    expect(blocked.approvalId).toMatch(/^belay_/)

    const stateDir = cursorAdapter.layout.repoLocalStateDir(repoRoot)
    const pendingPath = path.join(stateDir, 'pending-approvals.json')
    const pending = JSON.parse(await readFile(pendingPath, 'utf8')) as {
      approvals: Array<{
        approvalId: string
        scopeHint?: { scope: string; path: string }
      }>
    }
    const approval = pending.approvals.find((entry) => entry.approvalId === blocked.approvalId)
    expect(approval?.scopeHint).toBeUndefined()
  })
})
