import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { cursorAdapter } from '../adapters/cursor/adapter.js'
import {
  createDefaultGateRuntimeDeps,
  evaluateGatedAction,
  type GateRuntimeDeps,
  processApprovalPrompt,
} from '../adapters/shared/gate-runtime.js'
import { loadConfigFile } from '../config-io.js'
import { mergeConfig } from '../core/config.js'

const tempDirs: string[] = []

async function createTempRepo() {
  const repoRoot = await mkdtemp(path.join(os.tmpdir(), 'belay-approval-replay-'))
  tempDirs.push(repoRoot)
  await mkdir(path.join(repoRoot, '.git'))
  await cursorAdapter.install(repoRoot, {})

  const existing = await loadConfigFile(repoRoot, 'cursor')
  const configured = mergeConfig({
    ...existing,
    mode: 'enforce',
    policy: {
      ...existing.policy,
      unknownLocalEffect: 'deny',
    },
  })
  await writeFile(
    cursorAdapter.layout.configPath(repoRoot),
    `${JSON.stringify(configured, null, 2)}\n`,
    'utf8',
  )
  return repoRoot
}

describe('approval prompt replay fallback (cursor)', () => {
  afterEach(async () => {
    delete process.env.BELAY_TEST_APPROVAL_REPLAY
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
  })

  it('consumes approved grant when fallback replay succeeds', async () => {
    process.env.BELAY_TEST_APPROVAL_REPLAY = '1'
    const repoRoot = await createTempRepo()
    const config = await loadConfigFile(repoRoot, 'cursor')
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
      command: 'true',
    })
    expect(denied.permission).toBe('deny')
    expect(denied.approvalId).toBeTruthy()

    const approval = await processApprovalPrompt(
      ctx,
      deps,
      `${config.tokenPrefix} ${denied.approvalId}`,
    )
    expect(approval.continue).toBe(false)
    expect(approval.user_message).toContain('replay succeeded')

    const recheck = await evaluateGatedAction(ctx, deps, {
      kind: 'shell',
      cwd: repoRoot,
      command: 'true',
    })
    expect(recheck.reason).not.toBe('approved_once')
    expect(recheck.permission).toBe('deny')
  })

  it('keeps approved grant when fallback replay fails', async () => {
    process.env.BELAY_TEST_APPROVAL_REPLAY = '1'
    const repoRoot = await createTempRepo()
    const config = await loadConfigFile(repoRoot, 'cursor')
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
      command: 'false',
    })
    expect(denied.permission).toBe('deny')
    expect(denied.approvalId).toBeTruthy()

    const approval = await processApprovalPrompt(
      ctx,
      deps,
      `${config.tokenPrefix} ${denied.approvalId}`,
    )
    expect(approval.continue).toBe(false)
    expect(approval.user_message).toContain('replay failed')

    const recheck = await evaluateGatedAction(ctx, deps, {
      kind: 'shell',
      cwd: repoRoot,
      command: 'false',
    })
    expect(recheck.reason).toBe('approved_once')
    expect(recheck.permission).toBe('allow')
  })

  it('keeps approved grant when fallback replay throws', async () => {
    process.env.BELAY_TEST_APPROVAL_REPLAY = '1'
    const repoRoot = await createTempRepo()
    const config = await loadConfigFile(repoRoot, 'cursor')
    const ctx = {
      layout: cursorAdapter.layout,
      repoRoot,
      config,
      configPath: cursorAdapter.layout.configPath(repoRoot),
    }
    const deps = createDefaultGateRuntimeDeps()
    const missingCwd = path.join(repoRoot, 'gone-cwd')
    await mkdir(missingCwd, { recursive: true })

    const denied = await evaluateGatedAction(ctx, deps, {
      kind: 'shell',
      cwd: missingCwd,
      command: 'true',
    })
    expect(denied.permission).toBe('deny')
    expect(denied.approvalId).toBeTruthy()
    await rm(missingCwd, { recursive: true, force: true })

    const approval = await processApprovalPrompt(
      ctx,
      deps,
      `${config.tokenPrefix} ${denied.approvalId}`,
    )
    expect(approval.continue).toBe(false)
    expect(approval.user_message).toContain('could not start')

    const recheck = await evaluateGatedAction(ctx, deps, {
      kind: 'shell',
      cwd: missingCwd,
      command: 'true',
    })
    expect(recheck.reason).toBe('approved_once')
    expect(recheck.permission).toBe('allow')
  })

  it('keeps approved grant when replay consumption fails after success', async () => {
    process.env.BELAY_TEST_APPROVAL_REPLAY = '1'
    const repoRoot = await createTempRepo()
    const config = await loadConfigFile(repoRoot, 'cursor')
    const ctx = {
      layout: cursorAdapter.layout,
      repoRoot,
      config,
      configPath: cursorAdapter.layout.configPath(repoRoot),
    }
    const baseDeps = createDefaultGateRuntimeDeps()
    let throwOnConsumeWrite = false
    const deps: GateRuntimeDeps = {
      ...baseDeps,
      async writeApprovals(filePath, state) {
        if (
          throwOnConsumeWrite &&
          filePath.endsWith('approved-approvals.json') &&
          state.approvals.length === 0
        ) {
          throwOnConsumeWrite = false
          throw new Error('simulated approved write failure')
        }
        await baseDeps.writeApprovals(filePath, state)
      },
    }

    const denied = await evaluateGatedAction(ctx, deps, {
      kind: 'shell',
      cwd: repoRoot,
      command: 'true',
    })
    expect(denied.permission).toBe('deny')
    expect(denied.approvalId).toBeTruthy()

    throwOnConsumeWrite = true
    const approval = await processApprovalPrompt(
      ctx,
      deps,
      `${config.tokenPrefix} ${denied.approvalId}`,
    )
    expect(approval.continue).toBe(false)
    expect(approval.user_message).toContain('approval finalization failed')

    const recheck = await evaluateGatedAction(ctx, deps, {
      kind: 'shell',
      cwd: repoRoot,
      command: 'true',
    })
    expect(recheck.reason).toBe('approved_once')
    expect(recheck.permission).toBe('allow')
  })

  it('does not auto-replay by default in test runtime', async () => {
    const repoRoot = await createTempRepo()
    const config = await loadConfigFile(repoRoot, 'cursor')
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
      command: 'true',
    })
    const approval = await processApprovalPrompt(
      ctx,
      deps,
      `${config.tokenPrefix} ${denied.approvalId}`,
    )
    expect(approval.user_message).toContain('Retry this shell command unchanged')
  })
})
