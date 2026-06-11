import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'

import { afterEach, describe, expect, it } from 'vitest'
import { cursorAdapter } from '../adapters/cursor/adapter.js'
import {
  createDefaultGateRuntimeDeps,
  evaluateGatedAction,
} from '../adapters/shared/gate-runtime.js'
import { createApprovalRecord } from '../core/approval.js'
import { classifyShell } from '../core/classify-shell.js'
import { DEFAULT_CONFIG_V3 } from '../core/config.js'
import { TRANSACTIONAL_ALREADY_APPLIED } from '../core/transactional/reasons.js'

const execFileAsync = promisify(execFile)
const tempDirs: string[] = []

async function createGitRepo(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'belay-tx-gate-'))
  tempDirs.push(dir)
  await execFileAsync('git', ['init'], { cwd: dir })
  await execFileAsync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir })
  await execFileAsync('git', ['config', 'user.name', 'Test'], { cwd: dir })
  await writeFile(path.join(dir, 'README.md'), '# test\n')
  await execFileAsync('git', ['add', 'README.md'], { cwd: dir })
  await execFileAsync('git', ['commit', '-m', 'init'], { cwd: dir })
  return dir
}

function transactionalConfig() {
  return {
    ...DEFAULT_CONFIG_V3,
    policy: {
      ...DEFAULT_CONFIG_V3.policy,
      unknownLocalEffect: 'allow_flagged' as const,
      transactional: {
        ...DEFAULT_CONFIG_V3.policy.transactional,
        enabled: true,
      },
    },
    controlPlane: {
      ...DEFAULT_CONFIG_V3.controlPlane,
      enabled: false,
      configDir: null,
      integrity: 'none' as const,
      spikeOnPrompt: false,
    },
    audit: { logPath: '.cursor/belay/audit.ndjson', includeAssessment: true },
  }
}

describe('transactional gate runtime', () => {
  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
  })

  it('denies re-execution after applying observed-safe effects', async () => {
    const repoRoot = await createGitRepo()
    await mkdir(path.join(repoRoot, '.cursor', 'belay'), { recursive: true })
    const ctx = {
      layout: cursorAdapter.layout,
      repoRoot,
      config: transactionalConfig(),
      configPath: cursorAdapter.layout.configPath(repoRoot),
    }
    const deps = createDefaultGateRuntimeDeps()

    const verdict = await evaluateGatedAction(ctx, deps, {
      kind: 'shell',
      cwd: repoRoot,
      command: 'touch safe.txt',
    })

    expect(verdict.permission).toBe('deny')
    expect(verdict.reason).toBe(TRANSACTIONAL_ALREADY_APPLIED)
    await expect(readFile(path.join(repoRoot, 'safe.txt'), 'utf8')).resolves.toBeDefined()
  })

  it('does not let one-shot approval bypass transactional observed risk', async () => {
    const repoRoot = await createGitRepo()
    const config = {
      ...transactionalConfig(),
      policy: {
        ...transactionalConfig().policy,
        transactional: {
          ...transactionalConfig().policy.transactional,
          maxDeletionCount: 0,
        },
      },
    }
    const ctx = {
      layout: cursorAdapter.layout,
      repoRoot,
      config,
      configPath: cursorAdapter.layout.configPath(repoRoot),
    }
    const predicted = classifyShell('rm -f README.md', repoRoot, repoRoot, {
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

    const deps = createDefaultGateRuntimeDeps()
    const verdict = await evaluateGatedAction(ctx, deps, {
      kind: 'shell',
      cwd: repoRoot,
      command: 'rm -f README.md',
    })

    expect(verdict.permission).toBe('deny')
    expect(verdict.reason).toBe('transactional_observed_risk')
    await expect(readFile(path.join(repoRoot, 'README.md'), 'utf8')).resolves.toContain('# test')
  })
})
