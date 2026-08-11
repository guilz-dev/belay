import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { claudeAdapter } from '../adapters/claude/adapter.js'
import { codexAdapter } from '../adapters/codex/adapter.js'
import { cursorAdapter } from '../adapters/cursor/adapter.js'
import {
  createDefaultGateRuntimeDeps,
  evaluateGatedAction,
  type GateRuntimeDeps,
  processApprovalPrompt,
} from '../adapters/shared/gate-runtime.js'
import type { BelayAdapter } from '../adapters/types.js'
import { loadConfigFile } from '../config-io.js'
import { BoundaryCleanupError } from '../core/capability/boundary-run.js'
import { mergeConfig } from '../core/config.js'

const tempDirs: string[] = []

async function createTempRepo(adapter: BelayAdapter = cursorAdapter) {
  const repoRoot = await mkdtemp(path.join(os.tmpdir(), 'belay-approval-replay-'))
  tempDirs.push(repoRoot)
  await mkdir(path.join(repoRoot, '.git'))
  await adapter.install(repoRoot, {})

  const existing = await loadConfigFile(repoRoot, adapter.name)
  const configured = mergeConfig({
    ...existing,
    mode: 'enforce',
    policy: {
      ...existing.policy,
      unknownLocalEffect: 'deny',
    },
  })
  await writeFile(
    adapter.layout.configPath(repoRoot),
    `${JSON.stringify(configured, null, 2)}\n`,
    'utf8',
  )
  return repoRoot
}

describe('approval prompt shell replay', () => {
  afterEach(async () => {
    delete process.env.BELAY_DETERMINISTIC_JUDGE
    delete process.env.BELAY_TEST_APPROVAL_REPLAY
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
  })

  it('consumes approved grant when fallback replay succeeds', async () => {
    process.env.BELAY_DETERMINISTIC_JUDGE = '1'
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
    expect(approval.continue).toBe(true)
    expect(approval.user_message).toContain('replay succeeded')

    const recheck = await evaluateGatedAction(ctx, deps, {
      kind: 'shell',
      cwd: repoRoot,
      command: 'true',
    })
    expect(recheck.reason).not.toBe('approved_once')
    expect(recheck.permission).toBe('deny')
  })

  for (const adapter of [claudeAdapter, codexAdapter]) {
    it(`replays an approved shell action without a follow-up prompt on ${adapter.name}`, async () => {
      process.env.BELAY_DETERMINISTIC_JUDGE = '1'
      process.env.BELAY_TEST_APPROVAL_REPLAY = '1'
      const repoRoot = await createTempRepo(adapter)
      const config = await loadConfigFile(repoRoot, adapter.name)
      const ctx = {
        layout: adapter.layout,
        repoRoot,
        config,
        configPath: adapter.layout.configPath(repoRoot),
      }
      const deps = createDefaultGateRuntimeDeps()

      const denied = await evaluateGatedAction(ctx, deps, {
        kind: 'shell',
        cwd: repoRoot,
        command: 'true',
      })
      expect(denied.permission).toBe('deny')
      expect(denied.approvalId).toBeTruthy()
      expect(denied.user_message).toContain('No follow-up prompt is required')
      expect(denied.agent_message).toContain('replay the exact shell action automatically')

      const approval = await processApprovalPrompt(
        ctx,
        deps,
        `${config.tokenPrefix} ${denied.approvalId}`,
      )
      expect(approval.continue).toBe(true)
      expect(approval.user_message).toContain('replay succeeded')

      const recheck = await evaluateGatedAction(ctx, deps, {
        kind: 'shell',
        cwd: repoRoot,
        command: 'true',
      })
      expect(recheck.reason).not.toBe('approved_once')
      expect(recheck.permission).toBe('deny')
    })
  }

  it('spends the approved grant before replay and does not re-arm it after failure', async () => {
    process.env.BELAY_DETERMINISTIC_JUDGE = '1'
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
    expect(recheck.reason).not.toBe('approved_once')
    expect(recheck.permission).toBe('deny')
  })

  it('never includes raw shell replay output in agent-facing failure messages', async () => {
    process.env.BELAY_DETERMINISTIC_JUDGE = '1'
    process.env.BELAY_TEST_APPROVAL_REPLAY = '1'
    const repoRoot = await createTempRepo()
    const config = mergeConfig({
      ...(await loadConfigFile(repoRoot, 'cursor')),
      redaction: {
        maskApprovalIds: false,
        maskBearerTokens: false,
        maskAuthHeaders: false,
        maskKeyValueSecrets: false,
        maskHighEntropyStrings: false,
      },
    })
    const ctx = {
      layout: cursorAdapter.layout,
      repoRoot,
      config,
      configPath: cursorAdapter.layout.configPath(repoRoot),
    }
    const baseDeps = createDefaultGateRuntimeDeps()
    const deps: GateRuntimeDeps = {
      ...baseDeps,
      async replayApprovedShell() {
        return {
          exitCode: 1,
          signal: null,
          timedOut: false,
          stdout: '',
          stderr: 'remote rejected credential ghp_abcdefghijklmnopqrstuvwxyz0123456789AB',
        }
      },
    }

    const denied = await evaluateGatedAction(ctx, deps, {
      kind: 'shell',
      cwd: repoRoot,
      command: 'false',
    })
    const approval = await processApprovalPrompt(
      ctx,
      deps,
      `${config.tokenPrefix} ${denied.approvalId}`,
    )

    expect(approval.continue).toBe(false)
    expect(approval.user_message).toContain('replay failed')
    expect(approval.user_message).not.toContain('ghp_abcdefghijklmnopqrstuvwxyz0123456789AB')
    expect(approval.user_message).not.toContain('Replay stderr:')
  })

  it('omits replay output when residual credentials remain after scrubbing', async () => {
    process.env.BELAY_DETERMINISTIC_JUDGE = '1'
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
    const deps: GateRuntimeDeps = {
      ...baseDeps,
      async replayApprovedShell() {
        return {
          exitCode: 1,
          signal: null,
          timedOut: false,
          stdout: '',
          stderr: 'remote rejected credential sk-live-abcdef1234567890',
        }
      },
    }

    const denied = await evaluateGatedAction(ctx, deps, {
      kind: 'shell',
      cwd: repoRoot,
      command: 'false',
    })
    const approval = await processApprovalPrompt(
      ctx,
      deps,
      `${config.tokenPrefix} ${denied.approvalId}`,
    )

    expect(approval.user_message).toContain('replay failed')
    expect(approval.user_message).not.toContain('sk-live-abcdef1234567890')
    expect(approval.user_message).not.toContain('Replay stderr:')
  })

  it('treats a timed-out zero exit as failure and consumes the one-shot approval', async () => {
    process.env.BELAY_DETERMINISTIC_JUDGE = '1'
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
    const auditReasons: string[] = []
    const deps: GateRuntimeDeps = {
      ...baseDeps,
      async appendAudit(auditCtx, entry) {
        if (typeof entry.reason === 'string') {
          auditReasons.push(entry.reason)
        }
        await baseDeps.appendAudit(auditCtx, entry)
      },
      async replayApprovedShell() {
        return { exitCode: 0, signal: null, timedOut: true }
      },
    }

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

    expect(approval.continue).toBe(false)
    expect(approval.user_message).toContain('timed out')
    expect(approval.user_message).not.toContain('replay succeeded')
    expect(auditReasons).toContain('approval_replay_failed')
    expect(auditReasons).not.toContain('approval_replay_succeeded')

    const recheck = await evaluateGatedAction(ctx, baseDeps, {
      kind: 'shell',
      cwd: repoRoot,
      command: 'true',
    })
    expect(recheck.reason).not.toBe('approved_once')
    expect(recheck.permission).toBe('deny')
  })

  it('reports started execution when container cleanup is unconfirmed and consumes approval', async () => {
    process.env.BELAY_DETERMINISTIC_JUDGE = '1'
    process.env.BELAY_TEST_APPROVAL_REPLAY = '1'
    const repoRoot = await createTempRepo()
    const config = await loadConfigFile(repoRoot, 'cursor')
    const ctx = {
      layout: cursorAdapter.layout,
      repoRoot,
      config,
      configPath: cursorAdapter.layout.configPath(repoRoot),
    }
    const containerName = 'belay-run-123e4567-e89b-42d3-a456-426614174000'
    const baseDeps = createDefaultGateRuntimeDeps()
    const auditReasons: string[] = []
    const deps: GateRuntimeDeps = {
      ...baseDeps,
      async appendAudit(auditCtx, entry) {
        if (typeof entry.reason === 'string') {
          auditReasons.push(entry.reason)
        }
        await baseDeps.appendAudit(auditCtx, entry)
      },
      async replayApprovedShell() {
        throw new BoundaryCleanupError('container', containerName)
      },
    }

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

    expect(approval.continue).toBe(false)
    expect(approval.user_message).toContain('started')
    expect(approval.user_message).toContain('cleanup could not be confirmed')
    expect(approval.user_message).toContain('may still be running')
    expect(approval.user_message).toContain(containerName)
    expect(auditReasons).toContain('approval_replay_cleanup_unconfirmed')
    expect(auditReasons).not.toContain('approval_replay_error')

    const recheck = await evaluateGatedAction(ctx, baseDeps, {
      kind: 'shell',
      cwd: repoRoot,
      command: 'true',
    })
    expect(recheck.reason).not.toBe('approved_once')
    expect(recheck.permission).toBe('deny')
  })

  it('omits an untrusted cleanup resource id without changing cleanup classification', async () => {
    process.env.BELAY_DETERMINISTIC_JUDGE = '1'
    process.env.BELAY_TEST_APPROVAL_REPLAY = '1'
    const repoRoot = await createTempRepo()
    const config = await loadConfigFile(repoRoot, 'cursor')
    const ctx = {
      layout: cursorAdapter.layout,
      repoRoot,
      config,
      configPath: cursorAdapter.layout.configPath(repoRoot),
    }
    const untrustedId = 'attacker-controlled\ntext'
    const baseDeps = createDefaultGateRuntimeDeps()
    const auditReasons: string[] = []
    const deps: GateRuntimeDeps = {
      ...baseDeps,
      async appendAudit(auditCtx, entry) {
        if (typeof entry.reason === 'string') {
          auditReasons.push(entry.reason)
        }
        await baseDeps.appendAudit(auditCtx, entry)
      },
      async replayApprovedShell() {
        throw new BoundaryCleanupError('container', untrustedId)
      },
    }

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

    expect(approval.continue).toBe(false)
    expect(approval.user_message).toContain('cleanup could not be confirmed')
    expect(approval.user_message).not.toContain('attacker-controlled')
    expect(approval.user_message).not.toContain('text')
    expect(auditReasons).toContain('approval_replay_cleanup_unconfirmed')
  })

  it('omits approval-store errors when the approved replay cannot be claimed', async () => {
    process.env.BELAY_DETERMINISTIC_JUDGE = '1'
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
    let approvedRecordWritten = false
    const deps: GateRuntimeDeps = {
      ...baseDeps,
      async writeApprovals(filePath, state) {
        if (filePath.endsWith('approved-approvals.json')) {
          if (approvedRecordWritten && state.approvals.length === 0) {
            throw new Error('approval store contains secret-value')
          }
          approvedRecordWritten ||= state.approvals.length > 0
        }
        await baseDeps.writeApprovals(filePath, state)
      },
    }

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

    expect(approval.continue).toBe(false)
    expect(approval.user_message).toContain('could not be claimed')
    expect(approval.user_message).toContain('was not started')
    expect(approval.user_message).not.toContain('approval store contains')
    expect(approval.user_message).not.toContain('secret-value')
  })

  it('does not re-arm the approved grant when replay cannot start', async () => {
    process.env.BELAY_DETERMINISTIC_JUDGE = '1'
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
    expect(approval.user_message).toContain('replay failed')

    const recheck = await evaluateGatedAction(ctx, deps, {
      kind: 'shell',
      cwd: missingCwd,
      command: 'true',
    })
    expect(recheck.reason).not.toBe('approved_once')
    expect(recheck.permission).toBe('deny')
  })

  it('omits errors thrown before shell replay starts', async () => {
    process.env.BELAY_DETERMINISTIC_JUDGE = '1'
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
    const deps: GateRuntimeDeps = {
      ...baseDeps,
      async replayApprovedShell() {
        throw new Error('boundary setup failed token=secret-value')
      },
    }

    const denied = await evaluateGatedAction(ctx, deps, {
      kind: 'shell',
      cwd: repoRoot,
      command: 'false',
    })
    const approval = await processApprovalPrompt(
      ctx,
      deps,
      `${config.tokenPrefix} ${denied.approvalId}`,
    )

    expect(approval.user_message).toContain('could not start')
    expect(approval.user_message).not.toContain('boundary setup failed')
    expect(approval.user_message).not.toContain('token=<redacted>')
    expect(approval.user_message).not.toContain('secret-value')
  })

  it('claims the approved grant before invoking the boundary replay dependency', async () => {
    process.env.BELAY_DETERMINISTIC_JUDGE = '1'
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
    let approvedCountDuringReplay: number | undefined
    const deps: GateRuntimeDeps = {
      ...baseDeps,
      async replayApprovedShell(replayCtx) {
        const approved = await baseDeps.loadApprovals(replayCtx, 'approved-approvals.json')
        approvedCountDuringReplay = approved.state.approvals.length
        return { exitCode: 0, signal: null, timedOut: false }
      },
    }

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
    expect(approval.continue).toBe(true)
    expect(approval.user_message).toContain('replay succeeded')
    expect(approvedCountDuringReplay).toBe(0)

    const recheck = await evaluateGatedAction(ctx, deps, {
      kind: 'shell',
      cwd: repoRoot,
      command: 'true',
    })
    expect(recheck.reason).not.toBe('approved_once')
    expect(recheck.permission).toBe('deny')
  })

  it('reports replay success even when the post-replay audit write fails', async () => {
    process.env.BELAY_DETERMINISTIC_JUDGE = '1'
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
    const deps: GateRuntimeDeps = {
      ...baseDeps,
      async appendAudit(auditCtx, entry) {
        if (entry.reason === 'approval_replay_succeeded') {
          throw new Error('audit disk unavailable')
        }
        await baseDeps.appendAudit(auditCtx, entry)
      },
      async replayApprovedShell() {
        return { exitCode: 0, signal: null, timedOut: false }
      },
    }

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

    expect(approval.continue).toBe(true)
    expect(approval.user_message).toContain('replay succeeded')
    expect(approval.user_message).toContain('Audit recording failed')
    expect(approval.user_message).not.toContain('audit disk unavailable')

    const recheck = await evaluateGatedAction(ctx, baseDeps, {
      kind: 'shell',
      cwd: repoRoot,
      command: 'true',
    })
    expect(recheck.reason).not.toBe('approved_once')
  })

  it('continues a trailing instruction after replaying the approved shell action', async () => {
    process.env.BELAY_DETERMINISTIC_JUDGE = '1'
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

    const approval = await processApprovalPrompt(
      ctx,
      deps,
      `${config.tokenPrefix} ${denied.approvalId}\nprを作成して`,
    )

    expect(approval.continue).toBe(true)
    expect(approval.user_message).toContain('replay succeeded')
  })

  it('does not auto-replay by default in test runtime', async () => {
    process.env.BELAY_DETERMINISTIC_JUDGE = '1'
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
