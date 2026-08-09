import { execFile } from 'node:child_process'
import { lstat, mkdir, mkdtemp, readFile, readlink, rename, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'

import { afterEach, describe, expect, it } from 'vitest'
import { approvePending } from '../commands/approve.js'
import { recoveryCheckpointCommand } from '../commands/recovery-checkpoints.js'
import { loadApprovalState, writeConfigFile } from '../config-io.js'
import { issueApprovalToken } from '../core/approval-token.js'
import {
  configuredControlPlaneDir,
  DEFAULT_CONFIG_V3,
  DEFAULT_RECOVERY_CHECKPOINT,
} from '../core/config.js'
import { canonicalPath } from '../core/path-utils.js'
import {
  listRecoveryCheckpoints,
  RECOVERY_RESTORE_CONFLICT,
  reconcileRecoveryCheckpoint,
  recoveryRestoreBinding,
  restoreRecoveryCheckpoint,
  showRecoveryCheckpoint,
} from '../core/recovery/checkpoint.js'
import { runTransactionalExecution } from '../core/transactional/runner.js'
import { classifyShellCore } from './helpers/shell-classify.js'

const execFileAsync = promisify(execFile)
const tempDirs: string[] = []

async function createGitRepo(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'belay-recovery-'))
  tempDirs.push(dir)
  await execFileAsync('git', ['init'], { cwd: dir })
  await execFileAsync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir })
  await execFileAsync('git', ['config', 'user.name', 'Test'], { cwd: dir })
  await writeFile(path.join(dir, 'modified.txt'), 'before\n')
  await writeFile(path.join(dir, 'deleted.txt'), 'keep me\n')
  await writeFile(path.join(dir, 'script.sh'), '#!/bin/sh\necho before\n', { mode: 0o644 })
  await execFileAsync('ln', ['-s', 'modified.txt', 'current-link'], { cwd: dir })
  await execFileAsync('git', ['add', '.'], { cwd: dir })
  await execFileAsync('git', ['commit', '-m', 'init'], { cwd: dir })
  return dir
}

async function runCheckpointed(
  repoRoot: string,
  command: string,
  options?: { stateDir?: string; maxCheckpoints?: number },
) {
  const predicted = await classifyShellCore(command, repoRoot, repoRoot, {
    unknownLocalEffect: 'allow_flagged',
  })
  return runTransactionalExecution({
    command,
    cwd: repoRoot,
    repoRoot,
    stateDir: options?.stateDir ?? path.join(repoRoot, '.recovery-state'),
    timeoutMs: 10_000,
    predicted,
    fileCheckpoint: DEFAULT_CONFIG_V3.policy.transactional.fileCheckpoint,
    checkpoint: {
      ...DEFAULT_RECOVERY_CHECKPOINT,
      enabled: true,
      ...(options?.maxCheckpoints ? { maxCheckpoints: options.maxCheckpoints } : {}),
    },
    diffContext: {
      repoRoot: canonicalPath(repoRoot),
      sensitivePaths: DEFAULT_CONFIG_V3.classifier.sensitivePaths,
      protectedRoots: [],
      maxDeletionCount: 10,
    },
  })
}

describe('recovery checkpoints', () => {
  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
  })

  it('restores added, modified, deleted, symlink, and executable-mode changes', async () => {
    const repoRoot = await createGitRepo()
    const result = await runCheckpointed(
      repoRoot,
      "printf 'after\\n' > modified.txt; printf 'new\\n' > added.txt; rm deleted.txt; rm current-link; ln -s deleted.txt current-link; chmod +x script.sh",
    )

    expect(result.result.verdict).toBe('allow')
    expect(result.recoveryState).toBe('applied')
    const checkpointId = result.recoveryCheckpointId ?? ''
    const stateDir = path.join(repoRoot, '.recovery-state')
    const summary = (await listRecoveryCheckpoints(stateDir, repoRoot))[0]
    expect(summary?.state).toBe('applied')
    expect(summary?.receiptHash).toMatch(/^[a-f0-9]{64}$/)
    await expect(recoveryRestoreBinding(stateDir, checkpointId)).resolves.toMatchObject({
      repoRoot: canonicalPath(repoRoot),
    })

    await restoreRecoveryCheckpoint(stateDir, checkpointId)

    await expect(readFile(path.join(repoRoot, 'modified.txt'), 'utf8')).resolves.toBe('before\n')
    await expect(readFile(path.join(repoRoot, 'deleted.txt'), 'utf8')).resolves.toBe('keep me\n')
    await expect(readFile(path.join(repoRoot, 'added.txt'), 'utf8')).rejects.toThrow()
    await expect(readlink(path.join(repoRoot, 'current-link'))).resolves.toBe('modified.txt')
    expect((await lstat(path.join(repoRoot, 'script.sh'))).mode & 0o777).toBe(0o644)
    const restored = await showRecoveryCheckpoint(stateDir, checkpointId)
    expect(restored.state.state).toBe('restored')
    expect(restored.receipt?.postStateHash).toMatch(/^[a-f0-9]{64}$/)
  })

  it('leaves every target unchanged when post-state conflict is detected', async () => {
    const repoRoot = await createGitRepo()
    const result = await runCheckpointed(
      repoRoot,
      "printf 'after\\n' > modified.txt; printf 'new\\n' > added.txt",
    )
    const checkpointId = result.recoveryCheckpointId ?? ''
    const stateDir = path.join(repoRoot, '.recovery-state')
    await writeFile(path.join(repoRoot, 'modified.txt'), 'user edit\n')

    await expect(restoreRecoveryCheckpoint(stateDir, checkpointId)).rejects.toThrow(
      RECOVERY_RESTORE_CONFLICT,
    )
    await expect(readFile(path.join(repoRoot, 'modified.txt'), 'utf8')).resolves.toBe('user edit\n')
    await expect(readFile(path.join(repoRoot, 'added.txt'), 'utf8')).resolves.toBe('new\n')
    expect((await showRecoveryCheckpoint(stateDir, checkpointId)).state.state).toBe('conflict')
  })

  it('rejects a tampered pre-image before changing the repository', async () => {
    const repoRoot = await createGitRepo()
    const result = await runCheckpointed(repoRoot, "printf 'after\\n' > modified.txt")
    const checkpointId = result.recoveryCheckpointId ?? ''
    const stateDir = path.join(repoRoot, '.recovery-state')
    const loaded = await showRecoveryCheckpoint(stateDir, checkpointId)
    const blob = loaded.manifest.entries[0]?.before.blob ?? ''
    await writeFile(path.join(loaded.artifactDir, blob), 'tampered\n')

    await expect(restoreRecoveryCheckpoint(stateDir, checkpointId)).rejects.toThrow(
      'recovery_checkpoint_corrupt',
    )
    await expect(readFile(path.join(repoRoot, 'modified.txt'), 'utf8')).resolves.toBe('after\n')
  })

  it('requires and consumes an exact one-shot approval before CLI restore', async () => {
    const repoRoot = await createGitRepo()
    const stateDir = path.join(repoRoot, '.cursor', 'belay')
    const config = {
      ...DEFAULT_CONFIG_V3,
      controlPlane: { ...DEFAULT_CONFIG_V3.controlPlane, enabled: true, configDir: stateDir },
      policy: {
        ...DEFAULT_CONFIG_V3.policy,
        transactional: {
          ...DEFAULT_CONFIG_V3.policy.transactional,
          checkpoint: { ...DEFAULT_RECOVERY_CHECKPOINT, enabled: true },
        },
      },
    }
    await writeConfigFile(repoRoot, config)
    const predicted = await classifyShellCore(
      "printf 'after\\n' > modified.txt",
      repoRoot,
      repoRoot,
      { unknownLocalEffect: 'allow_flagged' },
    )
    const execution = await runTransactionalExecution({
      command: "printf 'after\\n' > modified.txt",
      cwd: repoRoot,
      repoRoot,
      stateDir,
      timeoutMs: 10_000,
      predicted,
      fileCheckpoint: config.policy.transactional.fileCheckpoint,
      checkpoint: config.policy.transactional.checkpoint,
      dirtyIgnoreRoots: [path.join(repoRoot, '.cursor')],
      diffContext: {
        repoRoot,
        sensitivePaths: config.classifier.sensitivePaths,
        protectedRoots: [],
        maxDeletionCount: 10,
      },
    })
    const checkpointId = execution.recoveryCheckpointId ?? ''

    const denied = await recoveryCheckpointCommand({
      targetDir: repoRoot,
      subcommand: 'apply',
      checkpointId,
    })
    expect(denied).toMatchObject({ ok: false, verdict: 'deny_pending_approval' })
    const approvalId = String(denied.approvalId)
    await expect(approvePending({ targetDir: repoRoot, approvalId })).resolves.toMatchObject({
      ok: false,
    })
    const pending = await loadApprovalState(repoRoot, 'pending-approvals.json', config)
    const request = pending.approvals.find((entry) => entry.approvalId === approvalId)
    expect(request).toBeDefined()
    const token = await issueApprovalToken(
      {
        approvalId,
        fingerprint: request?.fingerprint ?? '',
        repoRoot: request?.repoRoot ?? '',
        issuedAt: request?.createdAt ?? '',
        expiresAt: request?.expiresAt ?? '',
      },
      configuredControlPlaneDir(config),
    )
    await expect(approvePending({ targetDir: repoRoot, approvalId, token })).resolves.toMatchObject(
      { ok: true },
    )

    const attempts = await Promise.allSettled([
      recoveryCheckpointCommand({ targetDir: repoRoot, subcommand: 'apply', checkpointId }),
      recoveryCheckpointCommand({ targetDir: repoRoot, subcommand: 'apply', checkpointId }),
    ])
    const restored = attempts.filter(
      (attempt) =>
        attempt.status === 'fulfilled' &&
        attempt.value.ok === true &&
        attempt.value.verdict === 'restored',
    )
    expect(restored).toHaveLength(1)
    await expect(readFile(path.join(repoRoot, 'modified.txt'), 'utf8')).resolves.toBe('before\n')
    const approvedRaw = await readFile(
      path.join(repoRoot, '.cursor', 'belay', 'approved-approvals.json'),
      'utf8',
    )
    expect(JSON.parse(approvedRaw).approvals).toHaveLength(0)
    const pendingAfterRestore = await loadApprovalState(repoRoot, 'pending-approvals.json', config)
    expect(pendingAfterRestore.approvals).toHaveLength(0)
  })

  it('fails closed without touching the repo when checkpoint quota cannot be reserved', async () => {
    const repoRoot = await createGitRepo()
    const predicted = await classifyShellCore(
      "printf 'after\\n' > modified.txt",
      repoRoot,
      repoRoot,
      { unknownLocalEffect: 'allow_flagged' },
    )
    const result = await runTransactionalExecution({
      command: "printf 'after\\n' > modified.txt",
      cwd: repoRoot,
      repoRoot,
      stateDir: path.join(repoRoot, '.recovery-state'),
      timeoutMs: 10_000,
      predicted,
      fileCheckpoint: DEFAULT_CONFIG_V3.policy.transactional.fileCheckpoint,
      checkpoint: { ...DEFAULT_RECOVERY_CHECKPOINT, enabled: true, maxBytes: 1 },
      diffContext: {
        repoRoot,
        sensitivePaths: DEFAULT_CONFIG_V3.classifier.sensitivePaths,
        protectedRoots: [],
        maxDeletionCount: 10,
      },
    })

    expect(result.skipped).toBe(true)
    expect(result.skipReason).toBe('recovery_checkpoint_quota_exceeded')
    await expect(readFile(path.join(repoRoot, 'modified.txt'), 'utf8')).resolves.toBe('before\n')
  })

  it('requires a valid receipt before restore and leaves the repository untouched', async () => {
    const repoRoot = await createGitRepo()
    const result = await runCheckpointed(repoRoot, "printf 'after\\n' > modified.txt")
    const checkpointId = result.recoveryCheckpointId ?? ''
    const stateDir = path.join(repoRoot, '.recovery-state')
    const loaded = await showRecoveryCheckpoint(stateDir, checkpointId)
    await rm(path.join(loaded.artifactDir, 'receipt.json'))

    await expect(restoreRecoveryCheckpoint(stateDir, checkpointId)).rejects.toThrow(
      'recovery_checkpoint_corrupt',
    )
    await expect(readFile(path.join(repoRoot, 'modified.txt'), 'utf8')).resolves.toBe('after\n')
    expect((await listRecoveryCheckpoints(stateDir, repoRoot))[0]?.state).toBe('corrupt')
  })

  it('rejects a different Git repository recreated at the same path', async () => {
    const repoRoot = await createGitRepo()
    const result = await runCheckpointed(repoRoot, "printf 'after\\n' > modified.txt")
    const checkpointId = result.recoveryCheckpointId ?? ''
    const stateDir = path.join(repoRoot, '.recovery-state')
    await rename(path.join(repoRoot, '.git'), path.join(repoRoot, '.git-original'))
    await execFileAsync('git', ['init'], { cwd: repoRoot })

    await expect(restoreRecoveryCheckpoint(stateDir, checkpointId)).rejects.toThrow(
      'recovery_checkpoint_repo_mismatch',
    )
    await expect(readFile(path.join(repoRoot, 'modified.txt'), 'utf8')).resolves.toBe('after\n')
  })

  it('cleans orphaned staging directories and applies quotas per repository', async () => {
    const firstRepo = await createGitRepo()
    const secondRepo = await createGitRepo()
    const sharedStateDir = await mkdtemp(path.join(os.tmpdir(), 'belay-shared-recovery-'))
    tempDirs.push(sharedStateDir)
    const staging = path.join(
      sharedStateDir,
      'recovery',
      'checkpoints',
      `.tmp-cp_${'a'.repeat(24)}`,
    )
    await mkdir(staging, { recursive: true })
    await writeFile(
      path.join(staging, 'owner.json'),
      `${JSON.stringify({
        version: 1,
        pid: 2_147_483_647,
        createdAt: new Date(0).toISOString(),
        repoRoot: firstRepo,
      })}\n`,
    )

    await runCheckpointed(firstRepo, "printf 'first\\n' > modified.txt", {
      stateDir: sharedStateDir,
      maxCheckpoints: 1,
    })
    await expect(lstat(staging)).rejects.toThrow()
    const second = await runCheckpointed(secondRepo, "printf 'second\\n' > modified.txt", {
      stateDir: sharedStateDir,
      maxCheckpoints: 1,
    })
    expect(second.recoveryState).toBe('applied')
    expect(await listRecoveryCheckpoints(sharedStateDir, firstRepo)).toHaveLength(1)
    expect(await listRecoveryCheckpoints(sharedStateDir, secondRepo)).toHaveLength(1)
  })

  it('preserves leading and trailing spaces in checkpoint paths', async () => {
    const repoRoot = await createGitRepo()
    const spacedPath = ' leading and trailing '
    const result = await runCheckpointed(repoRoot, `printf 'new\\n' > '${spacedPath}'`)
    const checkpointId = result.recoveryCheckpointId ?? ''
    const stateDir = path.join(repoRoot, '.recovery-state')
    const loaded = await showRecoveryCheckpoint(stateDir, checkpointId)
    expect(loaded.manifest.entries.map((entry) => entry.path)).toContain(spacedPath)
    await restoreRecoveryCheckpoint(stateDir, checkpointId)
    await expect(lstat(path.join(repoRoot, spacedPath))).rejects.toThrow()
  })

  it('reconciles completed and mixed apply crashes without guessing', async () => {
    const repoRoot = await createGitRepo()
    const result = await runCheckpointed(
      repoRoot,
      "printf 'after\\n' > modified.txt; printf 'new\\n' > added.txt",
    )
    const checkpointId = result.recoveryCheckpointId ?? ''
    const stateDir = path.join(repoRoot, '.recovery-state')
    const loaded = await showRecoveryCheckpoint(stateDir, checkpointId)
    const statePath = path.join(loaded.artifactDir, 'state.json')
    await writeFile(
      statePath,
      `${JSON.stringify({
        version: 1,
        state: 'applying',
        updatedAt: new Date().toISOString(),
        manifestHash: loaded.manifestHash,
      })}\n`,
    )
    await expect(reconcileRecoveryCheckpoint(stateDir, checkpointId)).resolves.toBe('applied')

    await writeFile(path.join(repoRoot, 'modified.txt'), 'before\n')
    await writeFile(
      statePath,
      `${JSON.stringify({
        version: 1,
        state: 'applying',
        updatedAt: new Date().toISOString(),
        manifestHash: loaded.manifestHash,
      })}\n`,
    )
    await expect(reconcileRecoveryCheckpoint(stateDir, checkpointId)).resolves.toBe(
      'needs_manual_repair',
    )
    await expect(readFile(path.join(repoRoot, 'added.txt'), 'utf8')).resolves.toBe('new\n')
  })
})
