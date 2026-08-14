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
import { mintGrantForApprovedRecord } from '../core/capability/approval-v3.js'
import { recordCapabilityApproval } from '../core/capability-approval.js'
import { type BelayConfigV3, DEFAULT_CONFIG_V3 } from '../core/config.js'
import { canonicalPath } from '../core/path-utils.js'
import { createCapabilityApprovalStore } from '../services/sandbox-service.js'
import { classifyShellGated } from './helpers/shell-classify.js'

const tempDirs: string[] = []

function brokerInactiveConfig(): BelayConfigV3 {
  return {
    ...DEFAULT_CONFIG_V3,
    mode: 'enforce',
    policy: {
      ...DEFAULT_CONFIG_V3.policy,
      unknownLocalEffect: 'deny' as const,
    },
    sandbox: { ...DEFAULT_CONFIG_V3.sandbox, enabled: false },
    controlPlane: {
      enabled: false,
      configDir: null,
      integrity: 'none' as const,
      isolation: { mode: 'none' as const, verifyAgentWritable: true },
    },
    audit: { logPath: '.cursor/belay/audit.ndjson', includeAssessment: true },
  }
}

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

  it('does not let a standing path allowlist override effect policy', async () => {
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

    expect(verdict.permission).toBe('deny')
    expect(verdict.reason).toBe('outside_repo_mutation')
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

  it('consumes capability grant at gate runtime when fingerprint does not match', async () => {
    const repoRoot = await mkdtemp(path.join(os.tmpdir(), 'belay-cap-grant-'))
    tempDirs.push(repoRoot)
    await mkdir(path.join(repoRoot, '.git'))
    await writeFile(path.join(repoRoot, 'README.md'), '# hi\n')
    const outsidePath = path.join(repoRoot, '..', 'grant-out.txt')
    const command = `cp README.md ${outsidePath}`
    const config = brokerInactiveConfig()
    const ctx = {
      layout: cursorAdapter.layout,
      repoRoot,
      config,
      configPath: cursorAdapter.layout.configPath(repoRoot),
    }
    const deps = createDefaultGateRuntimeDeps()

    const denied = await evaluateGatedAction(ctx, deps, {
      kind: 'shell',
      cwd: repoRoot,
      command,
    })
    expect(denied.permission).toBe('deny')
    expect(denied.approvalId).toBeTruthy()

    const stateDir = cursorAdapter.layout.repoLocalStateDir(repoRoot)
    const pendingPath = path.join(stateDir, 'pending-approvals.json')
    const pending = JSON.parse(await readFile(pendingPath, 'utf8')) as {
      approvals: Array<{
        approvalId: string
        kind: string
        fingerprint: string
        repoRoot: string
        reason: string
        summary: string
        createdAt: string
        expiresAt: string
        capabilityRequests?: NonNullable<
          Awaited<ReturnType<typeof classifyShellGated>>['capabilityRequests']
        >
      }>
    }
    const pendingApproval = pending.approvals.find(
      (entry) => entry.approvalId === denied.approvalId,
    )
    expect(pendingApproval?.capabilityRequests?.length).toBeGreaterThan(0)
    if (!pendingApproval) {
      throw new Error('expected pending approval')
    }

    const approvedRecord = mintGrantForApprovedRecord({
      approvalId: pendingApproval.approvalId,
      kind: 'shell',
      fingerprint: 'mismatched-fingerprint',
      repoRoot,
      reason: pendingApproval.reason,
      summary: pendingApproval.summary,
      createdAt: pendingApproval.createdAt,
      expiresAt: pendingApproval.expiresAt,
      approvedAt: new Date().toISOString(),
      capabilityRequests: pendingApproval.capabilityRequests ?? [],
    })
    await writeFile(
      path.join(stateDir, 'approved-approvals.json'),
      `${JSON.stringify({ version: 3, approvals: [approvedRecord] }, null, 2)}\n`,
    )
    await writeFile(pendingPath, `${JSON.stringify({ version: 3, approvals: [] }, null, 2)}\n`)

    const first = await evaluateGatedAction(ctx, deps, {
      kind: 'shell',
      cwd: repoRoot,
      command,
    })
    expect(first.permission).toBe('allow')
    expect(first.reason).toBe('repo_outside_local_mutation')
    expect(first.authorizationDecision?.matchedRule).toBe('grant.exact')

    const approvedAfterFirst = JSON.parse(
      await readFile(path.join(stateDir, 'approved-approvals.json'), 'utf8'),
    ) as { approvals: Array<{ grant?: { usesRemaining: number } }> }
    expect(approvedAfterFirst.approvals[0]?.grant?.usesRemaining).toBe(0)

    const second = await evaluateGatedAction(ctx, deps, {
      kind: 'shell',
      cwd: repoRoot,
      command,
    })
    expect(second.permission).toBe('deny')
    expect(second.reason).toBe(pendingApproval.reason)
  })

  it('consumes every grant in a composite capability bundle at gate runtime', async () => {
    const repoRoot = await mkdtemp(path.join(os.tmpdir(), 'belay-cap-grant-bundle-'))
    tempDirs.push(repoRoot)
    await mkdir(path.join(repoRoot, '.git'))
    const command = 'npx -y prettier --version'
    const config = brokerInactiveConfig()
    const ctx = {
      layout: cursorAdapter.layout,
      repoRoot,
      config,
      configPath: cursorAdapter.layout.configPath(repoRoot),
    }
    const deps = createDefaultGateRuntimeDeps()

    const denied = await evaluateGatedAction(ctx, deps, {
      kind: 'shell',
      cwd: repoRoot,
      command,
    })
    expect(denied.permission).toBe('deny')
    expect(denied.capabilityRequests?.length ?? 0).toBeGreaterThan(1)

    const stateDir = cursorAdapter.layout.repoLocalStateDir(repoRoot)
    const pendingPath = path.join(stateDir, 'pending-approvals.json')
    const pending = JSON.parse(await readFile(pendingPath, 'utf8')) as {
      approvals: Array<{
        approvalId: string
        kind: string
        fingerprint: string
        repoRoot: string
        reason: string
        summary: string
        createdAt: string
        expiresAt: string
        capabilityRequests?: NonNullable<
          Awaited<ReturnType<typeof classifyShellGated>>['capabilityRequests']
        >
      }>
    }
    const pendingApproval = pending.approvals.find(
      (entry) => entry.approvalId === denied.approvalId,
    )
    if (!pendingApproval) {
      throw new Error('expected pending approval')
    }
    expect((pendingApproval.capabilityRequests ?? []).length).toBeGreaterThan(1)

    const approvedRecord = mintGrantForApprovedRecord({
      approvalId: pendingApproval.approvalId,
      kind: 'shell',
      fingerprint: 'mismatched-fingerprint',
      repoRoot,
      reason: pendingApproval.reason,
      summary: pendingApproval.summary,
      createdAt: pendingApproval.createdAt,
      expiresAt: pendingApproval.expiresAt,
      approvedAt: new Date().toISOString(),
      capabilityRequests: pendingApproval.capabilityRequests ?? [],
    })
    expect(approvedRecord.grants?.length).toBeGreaterThan(1)

    await writeFile(
      path.join(stateDir, 'approved-approvals.json'),
      `${JSON.stringify({ version: 3, approvals: [approvedRecord] }, null, 2)}\n`,
    )
    await writeFile(pendingPath, `${JSON.stringify({ version: 3, approvals: [] }, null, 2)}\n`)

    const first = await evaluateGatedAction(ctx, deps, {
      kind: 'shell',
      cwd: repoRoot,
      command,
    })
    expect(first.permission).toBe('allow')
    expect(first.authorizationDecision?.matchedRule).toBe('grant.exact')

    const approvedAfterFirst = JSON.parse(
      await readFile(path.join(stateDir, 'approved-approvals.json'), 'utf8'),
    ) as { approvals: Array<{ grants?: Array<{ usesRemaining: number }> }> }
    expect(
      approvedAfterFirst.approvals[0]?.grants?.every((grant) => grant.usesRemaining === 0),
    ).toBe(true)

    const second = await evaluateGatedAction(ctx, deps, {
      kind: 'shell',
      cwd: repoRoot,
      command,
    })
    expect(second.permission).toBe('deny')
    expect(second.reason).toBe('external_effect')
  })

  it('reuses an exhausted multi-grant bundle only within its execution lease', async () => {
    const repoRoot = await mkdtemp(path.join(os.tmpdir(), 'belay-cap-approved-bundle-'))
    tempDirs.push(repoRoot)
    await mkdir(path.join(repoRoot, '.git'))
    const command = 'npx -y prettier --version'
    const config = brokerInactiveConfig()
    const ctx = {
      layout: cursorAdapter.layout,
      repoRoot,
      config,
      configPath: cursorAdapter.layout.configPath(repoRoot),
    }
    const deps = createDefaultGateRuntimeDeps()

    const denied = await evaluateGatedAction(ctx, deps, {
      kind: 'shell',
      cwd: repoRoot,
      command,
    })
    expect(denied.permission).toBe('deny')

    const stateDir = cursorAdapter.layout.repoLocalStateDir(repoRoot)
    const pendingPath = path.join(stateDir, 'pending-approvals.json')
    const pending = JSON.parse(await readFile(pendingPath, 'utf8')) as {
      approvals: Array<{
        approvalId: string
        kind: string
        fingerprint: string
        repoRoot: string
        reason: string
        summary: string
        createdAt: string
        expiresAt: string
        capabilityRequests?: NonNullable<
          Awaited<ReturnType<typeof classifyShellGated>>['capabilityRequests']
        >
      }>
    }
    const pendingApproval = pending.approvals.find(
      (entry) => entry.approvalId === denied.approvalId,
    )
    if (!pendingApproval) {
      throw new Error('expected pending approval')
    }

    const approvedRecord = mintGrantForApprovedRecord({
      approvalId: pendingApproval.approvalId,
      kind: 'shell',
      fingerprint: pendingApproval.fingerprint,
      repoRoot,
      reason: pendingApproval.reason,
      summary: pendingApproval.summary,
      createdAt: pendingApproval.createdAt,
      expiresAt: pendingApproval.expiresAt,
      approvedAt: new Date().toISOString(),
      capabilityRequests: pendingApproval.capabilityRequests ?? [],
    })
    expect(approvedRecord.grants?.length ?? 0).toBeGreaterThan(1)

    await writeFile(
      path.join(stateDir, 'approved-approvals.json'),
      `${JSON.stringify({ version: 3, approvals: [approvedRecord] }, null, 2)}\n`,
    )
    await writeFile(pendingPath, `${JSON.stringify({ version: 3, approvals: [] }, null, 2)}\n`)

    const first = await evaluateGatedAction(ctx, deps, {
      kind: 'shell',
      cwd: repoRoot,
      command,
    })
    expect(first.permission).toBe('allow')
    expect(first.reason).toBe('approved_once')

    const approvedPath = path.join(stateDir, 'approved-approvals.json')
    const approvedAfterFirst = JSON.parse(await readFile(approvedPath, 'utf8')) as {
      approvals: Array<{
        executionLeaseExpiresAt?: string
        grants?: Array<{ usesRemaining: number }>
      }>
    }
    expect(approvedAfterFirst.approvals).toHaveLength(1)
    expect(approvedAfterFirst.approvals[0]?.executionLeaseExpiresAt).toBeDefined()
    expect(
      approvedAfterFirst.approvals[0]?.grants?.every((grant) => grant.usesRemaining === 0),
    ).toBe(true)

    const second = await evaluateGatedAction(ctx, deps, {
      kind: 'shell',
      cwd: repoRoot,
      command,
    })
    expect(second.permission).toBe('allow')
    expect(second.reason).toBe('approved_once')

    const expired = JSON.parse(await readFile(approvedPath, 'utf8')) as {
      version: number
      approvals: Array<{ executionLeaseExpiresAt?: string }>
    }
    if (!expired.approvals[0]) {
      throw new Error('expected leased approval')
    }
    expired.approvals[0].executionLeaseExpiresAt = new Date(Date.now() - 1_000).toISOString()
    await writeFile(approvedPath, `${JSON.stringify(expired, null, 2)}\n`)

    const afterLease = await evaluateGatedAction(ctx, deps, {
      kind: 'shell',
      cwd: repoRoot,
      command,
    })
    expect(afterLease.permission).toBe('deny')
  })

  it('replaces an invalid exact bundle with a fresh pending approval', async () => {
    const repoRoot = await mkdtemp(path.join(os.tmpdir(), 'belay-cap-incomplete-bundle-'))
    tempDirs.push(repoRoot)
    await mkdir(path.join(repoRoot, '.git'))
    const command = 'npx -y prettier --version'
    const config = brokerInactiveConfig()
    const ctx = {
      layout: cursorAdapter.layout,
      repoRoot,
      config,
      configPath: cursorAdapter.layout.configPath(repoRoot),
    }
    const deps = createDefaultGateRuntimeDeps()

    const denied = await evaluateGatedAction(ctx, deps, {
      kind: 'shell',
      cwd: repoRoot,
      command,
    })
    const stateDir = cursorAdapter.layout.repoLocalStateDir(repoRoot)
    const pendingPath = path.join(stateDir, 'pending-approvals.json')
    const pending = JSON.parse(await readFile(pendingPath, 'utf8')) as {
      approvals: Array<Parameters<typeof mintGrantForApprovedRecord>[0]>
    }
    const pendingApproval = pending.approvals.find(
      (entry) => entry.approvalId === denied.approvalId,
    )
    if (!pendingApproval) {
      throw new Error('expected pending approval')
    }
    const approvedRecord = mintGrantForApprovedRecord({
      ...pendingApproval,
      approvedAt: new Date().toISOString(),
    })
    expect(approvedRecord.grantBundleVersion).toBe(1)
    expect(approvedRecord.grants?.length ?? 0).toBeGreaterThan(1)
    approvedRecord.grants = approvedRecord.grants?.slice(0, -1)
    approvedRecord.grant = approvedRecord.grants?.[0]
    approvedRecord.executionLeaseExpiresAt = new Date(Date.now() + 60_000).toISOString()

    await writeFile(
      path.join(stateDir, 'approved-approvals.json'),
      `${JSON.stringify({ version: 3, approvals: [approvedRecord] }, null, 2)}\n`,
    )
    await writeFile(pendingPath, `${JSON.stringify({ version: 3, approvals: [] }, null, 2)}\n`)

    const replay = await evaluateGatedAction(ctx, deps, {
      kind: 'shell',
      cwd: repoRoot,
      command,
    })

    expect(replay.permission).toBe('deny')
    expect(replay.reason).toBe('capability_grant_unavailable')
    expect(replay.approvalId).toBeDefined()
    expect(replay.approvalId).not.toBe(approvedRecord.approvalId)
    const approvedAfter = JSON.parse(
      await readFile(path.join(stateDir, 'approved-approvals.json'), 'utf8'),
    ) as { approvals: unknown[] }
    expect(approvedAfter.approvals).toEqual([])

    const pendingAfter = JSON.parse(await readFile(pendingPath, 'utf8')) as {
      approvals: Array<{ approvalId: string }>
    }
    expect(pendingAfter.approvals).toEqual([
      expect.objectContaining({ approvalId: replay.approvalId }),
    ])

    const auditRecords = (await readFile(path.join(repoRoot, config.audit.logPath), 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>)
    expect(auditRecords.at(-1)).toMatchObject({
      reason: 'capability_grant_unavailable',
      grantBundleFailureReason: 'cardinality_mismatch',
      approvalId: '<approval-id>',
    })
  })

  it('deduplicates concurrent pending approvals atomically', async () => {
    const repoRoot = await mkdtemp(path.join(os.tmpdir(), 'belay-cap-concurrent-pending-'))
    tempDirs.push(repoRoot)
    await mkdir(path.join(repoRoot, '.git'))
    const config = brokerInactiveConfig()
    const ctx = {
      layout: cursorAdapter.layout,
      repoRoot,
      config,
      configPath: cursorAdapter.layout.configPath(repoRoot),
    }
    const baseDeps = createDefaultGateRuntimeDeps()
    let pendingLoads = 0
    let releasePendingLoads: (() => void) | undefined
    const pendingLoadsReady = new Promise<void>((resolve) => {
      releasePendingLoads = resolve
    })
    const deps = {
      ...baseDeps,
      async loadApprovals(...args: Parameters<typeof baseDeps.loadApprovals>) {
        const loaded = await baseDeps.loadApprovals(...args)
        if (args[1] === 'pending-approvals.json' && pendingLoads < 2) {
          pendingLoads += 1
          if (pendingLoads === 2) {
            releasePendingLoads?.()
          }
          await pendingLoadsReady
        }
        return loaded
      },
    }

    const verdicts = await Promise.all(
      Array.from({ length: 2 }, () =>
        evaluateGatedAction(ctx, deps, {
          kind: 'shell',
          cwd: repoRoot,
          command: 'npx -y prettier --version',
        }),
      ),
    )

    const approvalIds = new Set(verdicts.map((verdict) => verdict.approvalId))
    expect(approvalIds.size).toBe(1)
    const stateDir = cursorAdapter.layout.repoLocalStateDir(repoRoot)
    const pending = JSON.parse(
      await readFile(path.join(stateDir, 'pending-approvals.json'), 'utf8'),
    ) as { approvals: Array<{ approvalId: string }> }
    expect(pending.approvals).toHaveLength(1)
    expect(pending.approvals[0]?.approvalId).toBe(verdicts[0]?.approvalId)
  })

  it('denies replay when effect plan hash mismatches approved record', async () => {
    const repoRoot = await mkdtemp(path.join(os.tmpdir(), 'belay-cap-effect-plan-hash-'))
    tempDirs.push(repoRoot)
    await mkdir(path.join(repoRoot, '.git'))
    const command = 'npx -y prettier --version'
    const config = brokerInactiveConfig()
    const ctx = {
      layout: cursorAdapter.layout,
      repoRoot,
      config,
      configPath: cursorAdapter.layout.configPath(repoRoot),
    }
    const deps = createDefaultGateRuntimeDeps()

    const denied = await evaluateGatedAction(ctx, deps, {
      kind: 'shell',
      cwd: repoRoot,
      command,
    })
    expect(denied.permission).toBe('deny')

    const stateDir = cursorAdapter.layout.repoLocalStateDir(repoRoot)
    const pendingPath = path.join(stateDir, 'pending-approvals.json')
    const pending = JSON.parse(await readFile(pendingPath, 'utf8')) as {
      approvals: Array<{
        approvalId: string
        kind: string
        fingerprint: string
        repoRoot: string
        reason: string
        summary: string
        createdAt: string
        expiresAt: string
        effectPlanHash?: string
        capabilityRequests?: NonNullable<
          Awaited<ReturnType<typeof classifyShellGated>>['capabilityRequests']
        >
      }>
    }
    const pendingApproval = pending.approvals.find(
      (entry) => entry.approvalId === denied.approvalId,
    )
    if (!pendingApproval) {
      throw new Error('expected pending approval')
    }
    expect(pendingApproval.effectPlanHash).toBeTruthy()

    const approvedRecord = mintGrantForApprovedRecord({
      approvalId: pendingApproval.approvalId,
      kind: 'shell',
      fingerprint: pendingApproval.fingerprint,
      repoRoot,
      reason: pendingApproval.reason,
      summary: pendingApproval.summary,
      createdAt: pendingApproval.createdAt,
      expiresAt: pendingApproval.expiresAt,
      approvedAt: new Date().toISOString(),
      capabilityRequests: pendingApproval.capabilityRequests ?? [],
      effectPlanHash: 'tampered-effect-plan-hash',
    })

    await writeFile(
      path.join(stateDir, 'approved-approvals.json'),
      `${JSON.stringify({ version: 3, approvals: [approvedRecord] }, null, 2)}\n`,
    )
    await writeFile(pendingPath, `${JSON.stringify({ version: 3, approvals: [] }, null, 2)}\n`)

    const replay = await evaluateGatedAction(ctx, deps, {
      kind: 'shell',
      cwd: repoRoot,
      command,
    })
    expect(replay.permission).toBe('deny')
    expect(replay.reason).toBe('approval_replay_mismatch')
    expect(replay.approvalId).toBeDefined()
    expect(replay.approvalId).not.toBe(approvedRecord.approvalId)

    const approvedAfter = JSON.parse(
      await readFile(path.join(stateDir, 'approved-approvals.json'), 'utf8'),
    ) as { approvals: unknown[] }
    expect(approvedAfter.approvals).toEqual([])
    const pendingAfter = JSON.parse(await readFile(pendingPath, 'utf8')) as {
      approvals: Array<{ approvalId: string }>
    }
    expect(pendingAfter.approvals).toEqual([
      expect.objectContaining({ approvalId: replay.approvalId }),
    ])
    const auditRecords = (await readFile(path.join(repoRoot, config.audit.logPath), 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>)
    const mismatchAudit = auditRecords.at(-1)
    expect(mismatchAudit).toMatchObject({
      reason: 'approval_replay_mismatch',
      replayMismatchKind: 'effect_plan',
      rejectedApprovalId: '<approval-id>',
    })
    expect(mismatchAudit?.rejectedApprovalCorrelationId).toMatch(/^[0-9a-f]{16}$/)
    expect(mismatchAudit?.replacementApprovalCorrelationId).toMatch(/^[0-9a-f]{16}$/)
    expect(mismatchAudit?.rejectedApprovalCorrelationId).not.toBe(
      mismatchAudit?.replacementApprovalCorrelationId,
    )
  })

  it('allows replay for legacy approvals without effect plan hash', async () => {
    const repoRoot = await mkdtemp(path.join(os.tmpdir(), 'belay-cap-legacy-no-effect-hash-'))
    tempDirs.push(repoRoot)
    await mkdir(path.join(repoRoot, '.git'))
    const command = 'npx -y prettier --version'
    const config = brokerInactiveConfig()
    const ctx = {
      layout: cursorAdapter.layout,
      repoRoot,
      config,
      configPath: cursorAdapter.layout.configPath(repoRoot),
    }
    const deps = createDefaultGateRuntimeDeps()

    const denied = await evaluateGatedAction(ctx, deps, {
      kind: 'shell',
      cwd: repoRoot,
      command,
    })
    expect(denied.permission).toBe('deny')

    const stateDir = cursorAdapter.layout.repoLocalStateDir(repoRoot)
    const pendingPath = path.join(stateDir, 'pending-approvals.json')
    const pending = JSON.parse(await readFile(pendingPath, 'utf8')) as {
      approvals: Array<{
        approvalId: string
        kind: string
        fingerprint: string
        repoRoot: string
        reason: string
        summary: string
        createdAt: string
        expiresAt: string
        capabilityRequests?: NonNullable<
          Awaited<ReturnType<typeof classifyShellGated>>['capabilityRequests']
        >
      }>
    }
    const pendingApproval = pending.approvals.find(
      (entry) => entry.approvalId === denied.approvalId,
    )
    if (!pendingApproval) {
      throw new Error('expected pending approval')
    }

    const approvedRecord = mintGrantForApprovedRecord({
      approvalId: pendingApproval.approvalId,
      kind: 'shell',
      fingerprint: pendingApproval.fingerprint,
      repoRoot,
      reason: pendingApproval.reason,
      summary: pendingApproval.summary,
      createdAt: pendingApproval.createdAt,
      expiresAt: pendingApproval.expiresAt,
      approvedAt: new Date().toISOString(),
      capabilityRequests: pendingApproval.capabilityRequests ?? [],
    })
    expect(approvedRecord.effectPlanHash).toBeUndefined()

    await writeFile(
      path.join(stateDir, 'approved-approvals.json'),
      `${JSON.stringify({ version: 3, approvals: [approvedRecord] }, null, 2)}\n`,
    )
    await writeFile(pendingPath, `${JSON.stringify({ version: 3, approvals: [] }, null, 2)}\n`)

    const replay = await evaluateGatedAction(ctx, deps, {
      kind: 'shell',
      cwd: repoRoot,
      command,
    })
    expect(replay.permission).toBe('allow')
    expect(replay.authorizationDecision?.matchedRule).toBe('grant.exact')
  })

  it('denies a hashed approval when the authoritative effect plan hash differs', async () => {
    const repoRoot = await mkdtemp(path.join(os.tmpdir(), 'belay-cap-missing-effect-plan-'))
    tempDirs.push(repoRoot)
    await mkdir(path.join(repoRoot, '.git'))
    const command = 'unknown-command'
    const config = brokerInactiveConfig()
    const ctx = {
      layout: cursorAdapter.layout,
      repoRoot,
      config,
      configPath: cursorAdapter.layout.configPath(repoRoot),
    }
    const deps = createDefaultGateRuntimeDeps()

    const denied = await evaluateGatedAction(ctx, deps, {
      kind: 'shell',
      cwd: repoRoot,
      command,
    })
    expect(denied.permission).toBe('deny')

    const stateDir = cursorAdapter.layout.repoLocalStateDir(repoRoot)
    const pendingPath = path.join(stateDir, 'pending-approvals.json')
    const pending = JSON.parse(await readFile(pendingPath, 'utf8')) as {
      approvals: Array<Parameters<typeof mintGrantForApprovedRecord>[0]>
    }
    const pendingApproval = pending.approvals[0]
    if (!pendingApproval) {
      throw new Error('expected pending approval')
    }
    const approvedRecord = mintGrantForApprovedRecord({
      ...pendingApproval,
      approvedAt: new Date().toISOString(),
      effectPlanHash: 'effect-plan-required',
    })
    await writeFile(
      path.join(stateDir, 'approved-approvals.json'),
      `${JSON.stringify({ version: 3, approvals: [approvedRecord] }, null, 2)}\n`,
    )
    await writeFile(pendingPath, `${JSON.stringify({ version: 3, approvals: [] }, null, 2)}\n`)

    const replay = await evaluateGatedAction(ctx, deps, {
      kind: 'shell',
      cwd: repoRoot,
      command,
    })
    expect(replay.permission).toBe('deny')
    expect(replay.reason).toBe('approval_replay_mismatch')
  })

  it('prefers approved_once when fingerprint matches an approved record', async () => {
    const repoRoot = await mkdtemp(path.join(os.tmpdir(), 'belay-cap-approved-once-'))
    tempDirs.push(repoRoot)
    await mkdir(path.join(repoRoot, '.git'))
    const config = brokerInactiveConfig()
    const predicted = await classifyShellGated('unknown-command', repoRoot, repoRoot, config)
    expect(predicted.verdict).toBe('deny_pending_approval')

    const approval = createApprovalRecord({
      kind: 'shell',
      fingerprint: predicted.fingerprint,
      repoRoot,
      reason: predicted.reason,
      summary: predicted.normalizedCommand ?? 'unknown-command',
      approvalTtlMinutes: config.approvalTtlMinutes,
      approvalId: 'belay_approved_once_gate',
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
      command: 'unknown-command',
    })

    expect(verdict.permission).toBe('allow')
    expect(verdict.reason).toBe('approved_once')
  })
})
