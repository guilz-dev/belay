import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'

import { afterEach, describe, expect, it, vi } from 'vitest'
import { cursorAdapter } from '../adapters/cursor/adapter.js'
import {
  createDefaultGateRuntimeDeps,
  evaluateGatedAction,
} from '../adapters/shared/gate-runtime.js'
import { createApprovalRecord } from '../core/approval.js'
import { isDockerAvailable } from '../core/capability/boundary-driver-container.js'
import * as boundarySession from '../core/capability/boundary-session.js'
import { DEFAULT_CONFIG_V3, DEFAULT_RECOVERY_CHECKPOINT } from '../core/config.js'
import { RECOVERY_DIRTY_WORKTREE } from '../core/recovery/fail-closed.js'
import { FILE_CHECKPOINT_ISOLATION_UNAVAILABLE } from '../core/transactional/backend-selector.js'
import { runShellCommand } from '../core/transactional/git-worktree.js'
import { TRANSACTIONAL_ALREADY_APPLIED } from '../core/transactional/reasons.js'
import { classifyShellCore } from './helpers/shell-classify.js'

const execFileAsync = promisify(execFile)
const tempDirs: string[] = []
const dockerAvailable = await isDockerAvailable()
const DOCKER_TEST_TIMEOUT_MS = 60_000

async function createGitRepo(options?: { gitignoreCursor?: boolean }): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'belay-tx-gate-'))
  tempDirs.push(dir)
  await execFileAsync('git', ['init'], { cwd: dir })
  await execFileAsync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir })
  await execFileAsync('git', ['config', 'user.name', 'Test'], { cwd: dir })
  await writeFile(path.join(dir, 'README.md'), '# test\n')
  if (options?.gitignoreCursor !== false) {
    await writeFile(path.join(dir, '.gitignore'), '.cursor/\n')
    await execFileAsync('git', ['add', 'README.md', '.gitignore'], { cwd: dir })
  } else {
    await execFileAsync('git', ['add', 'README.md'], { cwd: dir })
  }
  await execFileAsync('git', ['commit', '-m', 'init'], { cwd: dir })
  return dir
}

function transactionalConfig() {
  return {
    ...DEFAULT_CONFIG_V3,
    mode: 'enforce' as const,
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
    },
    audit: { logPath: '.cursor/belay/audit.ndjson', includeAssessment: true },
  }
}

function transactionalContainerConfig() {
  return {
    ...transactionalConfig(),
    sandbox: {
      ...DEFAULT_CONFIG_V3.sandbox,
      enabled: true,
      runtime: 'container' as const,
    },
    capability: {
      grantsEnabled: true,
      boundaryDriver: 'container' as const,
      attestationRelPath: '.belay/attestation.json',
    },
  }
}

function transactionalFileCheckpointConfig() {
  const base = transactionalContainerConfig()
  return {
    ...base,
    policy: {
      ...base.policy,
      transactional: {
        ...base.policy.transactional,
        fileCheckpoint: {
          ...base.policy.transactional.fileCheckpoint,
          enabled: true,
        },
        checkpoint: {
          ...DEFAULT_RECOVERY_CHECKPOINT,
          enabled: true,
        },
      },
    },
  }
}

describe('transactional gate runtime', () => {
  afterEach(async () => {
    vi.restoreAllMocks()
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

  it('fail-closes dirty worktree instead of falling back to host execution', async () => {
    const repoRoot = await createGitRepo()
    await writeFile(path.join(repoRoot, 'README.md'), '# dirty\n')
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
    expect(verdict.reason).toBe(RECOVERY_DIRTY_WORKTREE)
    await expect(readFile(path.join(repoRoot, 'safe.txt'), 'utf8')).rejects.toThrow()
  })

  it('instructs the operator to start a boundary session when isolation is unavailable', async () => {
    const repoRoot = await createGitRepo()
    await writeFile(path.join(repoRoot, 'README.md'), '# dirty\n')
    await mkdir(path.join(repoRoot, '.cursor', 'belay'), { recursive: true })
    const ctx = {
      layout: cursorAdapter.layout,
      repoRoot,
      config: transactionalFileCheckpointConfig(),
      configPath: cursorAdapter.layout.configPath(repoRoot),
    }
    const deps = createDefaultGateRuntimeDeps()

    const verdict = await evaluateGatedAction(ctx, deps, {
      kind: 'shell',
      cwd: repoRoot,
      command: 'touch safe.txt',
    })

    expect(verdict.permission).toBe('deny')
    expect(verdict.reason).toBe(FILE_CHECKPOINT_ISOLATION_UNAVAILABLE)
    expect(verdict.user_message).toContain('belay session start')
    expect(verdict.user_message).not.toContain('Approval ID')
    await expect(readFile(path.join(repoRoot, 'safe.txt'), 'utf8')).rejects.toThrow()
  })

  it('runs dirty Git file_checkpoint through the gate and audits snapshot details', async () => {
    const repoRoot = await createGitRepo()
    await writeFile(path.join(repoRoot, 'README.md'), '# dirty\n')
    await mkdir(path.join(repoRoot, '.cursor', 'belay'), { recursive: true })
    const attestation = {
      version: 1 as const,
      driver: 'container' as const,
      probedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      deniesUngrantedEffects: true,
      materializesGrants: true,
      isolatesWorkspaceMounts: true,
      probeSignals: ['docker', 'workspace-mount-isolation'],
    }
    vi.spyOn(boundarySession, 'resolveBoundaryDriverContext').mockResolvedValue({
      driver: {
        id: 'container',
        async probe() {
          return attestation
        },
        async run(command, cwd, timeoutMs, options) {
          const mount = options?.workspaceMount
          return runShellCommand(command, mount ? mount.hostSourceRoot : cwd, timeoutMs)
        },
        materializeGrant() {
          return null
        },
      },
      driverId: 'container',
      proxyActive: false,
      proxyEnv: {},
      prepareContext: { repoRoot, egressProxyActive: false, proxyEnv: {} },
      attestationPath: path.join(repoRoot, '.belay', 'attestation.json'),
      attestation,
      attestationFresh: true,
    })
    const ctx = {
      layout: cursorAdapter.layout,
      repoRoot,
      config: transactionalFileCheckpointConfig(),
      configPath: cursorAdapter.layout.configPath(repoRoot),
    }

    const verdict = await evaluateGatedAction(ctx, createDefaultGateRuntimeDeps(), {
      kind: 'shell',
      cwd: repoRoot,
      command: 'touch safe-dirty.txt',
    })

    expect(verdict.permission).toBe('deny')
    expect(verdict.reason).toBe(TRANSACTIONAL_ALREADY_APPLIED)
    await expect(readFile(path.join(repoRoot, 'safe-dirty.txt'), 'utf8')).resolves.toBeDefined()
    const auditLines = (
      await readFile(path.join(repoRoot, '.cursor', 'belay', 'audit.ndjson'), 'utf8')
    )
      .trim()
      .split('\n')
    const audit = JSON.parse(auditLines.at(-1) ?? '{}')
    expect(audit).toMatchObject({
      transactional: true,
      transactionalBackend: 'file_checkpoint',
      resourceKind: 'git_repository',
      recoveryBackend: 'file_checkpoint',
    })
    expect(audit.baselineTreeHash).toBe('<high-entropy>')
    expect(audit.snapshotFileCount).toBeGreaterThan(0)
    expect(audit.snapshotWorkspaceBytes).toBeGreaterThan(audit.snapshotSourceBytes)
    expect(['clonefile', 'reflink', 'copy']).toContain(audit.snapshotCopyStrategy)
  })

  it('runs non-git file_checkpoint through the gate and audits directory resources', async () => {
    const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), 'belay-tx-gate-nongit-'))
    tempDirs.push(workspaceRoot)
    await writeFile(path.join(workspaceRoot, 'README.md'), '# plain\n')
    await mkdir(path.join(workspaceRoot, '.cursor', 'belay'), { recursive: true })
    const attestation = {
      version: 1 as const,
      driver: 'container' as const,
      probedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      deniesUngrantedEffects: true,
      materializesGrants: true,
      isolatesWorkspaceMounts: true,
      probeSignals: ['docker', 'workspace-mount-isolation'],
    }
    vi.spyOn(boundarySession, 'resolveBoundaryDriverContext').mockResolvedValue({
      driver: {
        id: 'container',
        async probe() {
          return attestation
        },
        async run(command, cwd, timeoutMs, options) {
          const mount = options?.workspaceMount
          return runShellCommand(command, mount ? mount.hostSourceRoot : cwd, timeoutMs)
        },
        materializeGrant() {
          return null
        },
      },
      driverId: 'container',
      proxyActive: false,
      proxyEnv: {},
      prepareContext: { repoRoot: workspaceRoot, egressProxyActive: false, proxyEnv: {} },
      attestationPath: path.join(workspaceRoot, '.belay', 'attestation.json'),
      attestation,
      attestationFresh: true,
    })
    const config = transactionalFileCheckpointConfig()
    const ctx = {
      layout: cursorAdapter.layout,
      repoRoot: workspaceRoot,
      config: {
        ...config,
        policy: {
          ...config.policy,
          transactional: {
            ...config.policy.transactional,
            fileCheckpoint: {
              ...config.policy.transactional.fileCheckpoint,
              allowNonGit: true,
            },
          },
        },
      },
      configPath: cursorAdapter.layout.configPath(workspaceRoot),
    }

    const verdict = await evaluateGatedAction(ctx, createDefaultGateRuntimeDeps(), {
      kind: 'shell',
      cwd: workspaceRoot,
      command: 'touch safe-plain.txt',
    })

    expect(verdict.permission).toBe('deny')
    expect(verdict.reason).toBe(TRANSACTIONAL_ALREADY_APPLIED)
    await expect(
      readFile(path.join(workspaceRoot, 'safe-plain.txt'), 'utf8'),
    ).resolves.toBeDefined()
    const auditLines = (
      await readFile(path.join(workspaceRoot, '.cursor', 'belay', 'audit.ndjson'), 'utf8')
    )
      .trim()
      .split('\n')
    const audit = JSON.parse(auditLines.at(-1) ?? '{}')
    expect(audit).toMatchObject({
      transactional: true,
      transactionalBackend: 'file_checkpoint',
      resourceKind: 'directory',
      recoveryBackend: 'file_checkpoint',
    })
  })

  it('runs transactional recovery when only belay init artifacts are untracked', async () => {
    const repoRoot = await createGitRepo({ gitignoreCursor: false })
    await mkdir(path.join(repoRoot, '.cursor', 'belay'), { recursive: true })
    await writeFile(path.join(repoRoot, '.cursor', 'belay', 'audit.ndjson'), '')
    await writeFile(path.join(repoRoot, '.cursor', 'belay.config.json'), '{}\n')
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
    const predicted = await classifyShellCore('rm -f README.md', repoRoot, repoRoot, {
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

  it.skipIf(!dockerAvailable)(
    'passes container driver id into resolveBoundaryDriverContext for transactional shell',
    async () => {
      const resolveSpy = vi.spyOn(boundarySession, 'resolveBoundaryDriverContext')
      const repoRoot = await createGitRepo()
      await mkdir(path.join(repoRoot, '.cursor', 'belay'), { recursive: true })
      const ctx = {
        layout: cursorAdapter.layout,
        repoRoot,
        config: transactionalContainerConfig(),
        configPath: cursorAdapter.layout.configPath(repoRoot),
      }
      const deps = createDefaultGateRuntimeDeps()

      await evaluateGatedAction(ctx, deps, {
        kind: 'shell',
        cwd: repoRoot,
        command: 'touch safe.txt',
      })

      expect(resolveSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          repoRoot,
          driverId: 'container',
        }),
      )
      const resolved = await resolveSpy.mock.results[0]?.value
      expect(resolved?.driverId).toBe('container')
    },
    DOCKER_TEST_TIMEOUT_MS,
  )

  it.skipIf(!dockerAvailable)(
    'applies observed-safe shell effects via container boundary driver',
    async () => {
      const repoRoot = await createGitRepo()
      await mkdir(path.join(repoRoot, '.cursor', 'belay'), { recursive: true })
      const ctx = {
        layout: cursorAdapter.layout,
        repoRoot,
        config: transactionalContainerConfig(),
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
    },
    DOCKER_TEST_TIMEOUT_MS,
  )
})
