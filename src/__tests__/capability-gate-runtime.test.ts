import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'
import { cursorAdapter } from '../adapters/cursor/adapter.js'
import {
  createDefaultGateRuntimeDeps,
  evaluateGatedAction,
} from '../adapters/shared/gate-runtime.js'
import { createApprovalRecord } from '../core/approval.js'
import { fsScopeAllowlistPath } from '../core/capability/allowlist.js'
import { type BelayConfigV3, DEFAULT_CONFIG_V3 } from '../core/config.js'
import { classifyShellCore } from './helpers/shell-classify.js'

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
  afterEach(async () => {
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
    const predicted = await classifyShellCore('cp README.md ../copy.txt', repoRoot, repoRoot, {
      brokerFsScope: true,
      unknownLocalEffect: 'allow_flagged',
    })
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
})
