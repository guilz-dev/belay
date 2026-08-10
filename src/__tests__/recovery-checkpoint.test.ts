import { execFile } from 'node:child_process'
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
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
import { canonicalStringify, hashValue } from '../core/fingerprint.js'
import { canonicalPath } from '../core/path-utils.js'
import {
  listRecoveryCheckpoints,
  markRecoveryCheckpointApplied,
  markRecoveryCheckpointApplying,
  prepareRecoveryCheckpoint,
  RECOVERY_RESTORE_CONFLICT,
  reconcileRecoveryCheckpoint,
  recoveryRestoreBinding,
  restoreRecoveryCheckpoint,
  showRecoveryCheckpoint,
} from '../core/recovery/checkpoint.js'
import { currentRecoveryResourceIdentity } from '../core/recovery/resource-identity.js'
import { recoveryDirectoryHash } from '../core/recovery/snapshot-node.js'
import type {
  RecoveryCheckpointManifest,
  RecoveryCheckpointManifestV1,
  RecoveryCheckpointStateV1,
  RecoveryReceiptV1,
} from '../core/recovery/types.js'
import { runTransactionalExecution } from '../core/transactional/runner.js'
import { classifyShellCore } from './helpers/shell-classify.js'

const execFileAsync = promisify(execFile)
const tempDirs: string[] = []
const fixtureRoot = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'fixtures',
  'recovery-checkpoint-v1',
)

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

async function installRecoveryV1Fixture(repoRoot: string): Promise<{
  checkpointId: string
  stateDir: string
}> {
  const stateDir = path.join(repoRoot, '.recovery-state')
  const manifest = JSON.parse(
    await readFile(path.join(fixtureRoot, 'manifest.json'), 'utf8'),
  ) as RecoveryCheckpointManifestV1
  const canonicalRepoRoot = canonicalPath(repoRoot)
  manifest.repoRoot = canonicalRepoRoot
  manifest.repoIdentity = await currentRecoveryResourceIdentity(repoRoot, 'git_repository')
  manifest.proof.resourceScope = canonicalRepoRoot
  const manifestHash = hashValue(canonicalStringify(manifest))
  const state = JSON.parse(
    await readFile(path.join(fixtureRoot, 'state.json'), 'utf8'),
  ) as RecoveryCheckpointStateV1
  state.manifestHash = manifestHash
  const receipt = JSON.parse(
    await readFile(path.join(fixtureRoot, 'receipt.json'), 'utf8'),
  ) as RecoveryReceiptV1
  receipt.manifestHash = manifestHash
  receipt.proofHash = hashValue(canonicalStringify(manifest.proof))
  receipt.postStateHash = hashValue(
    canonicalStringify(manifest.entries.map((entry) => ({ path: entry.path, state: entry.after }))),
  )
  const artifactDir = path.join(stateDir, 'recovery', 'checkpoints', manifest.checkpointId)
  await mkdir(path.join(artifactDir, 'blobs'), { recursive: true })
  await writeFile(path.join(artifactDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)
  await writeFile(path.join(artifactDir, 'state.json'), `${JSON.stringify(state, null, 2)}\n`)
  await writeFile(path.join(artifactDir, 'receipt.json'), `${JSON.stringify(receipt, null, 2)}\n`)
  const blobName = manifest.entries[0]?.before.blob ?? ''
  await copyFile(path.join(fixtureRoot, blobName), path.join(artifactDir, blobName))
  return { checkpointId: manifest.checkpointId, stateDir }
}

async function rewriteArtifactBindings(
  artifactDir: string,
  manifest: RecoveryCheckpointManifest,
): Promise<void> {
  const manifestHash = hashValue(canonicalStringify(manifest))
  await writeFile(path.join(artifactDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)
  const state = JSON.parse(
    await readFile(path.join(artifactDir, 'state.json'), 'utf8'),
  ) as RecoveryCheckpointStateV1
  state.manifestHash = manifestHash
  await writeFile(path.join(artifactDir, 'state.json'), `${JSON.stringify(state, null, 2)}\n`)
  const receipt = JSON.parse(
    await readFile(path.join(artifactDir, 'receipt.json'), 'utf8'),
  ) as RecoveryReceiptV1
  receipt.manifestHash = manifestHash
  receipt.proofHash = hashValue(canonicalStringify(manifest.proof))
  receipt.postStateHash = hashValue(
    canonicalStringify(manifest.entries.map((entry) => ({ path: entry.path, state: entry.after }))),
  )
  await writeFile(path.join(artifactDir, 'receipt.json'), `${JSON.stringify(receipt, null, 2)}\n`)
}

describe('recovery checkpoints', () => {
  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
  })

  it('emits manifest v2 for new Git worktree checkpoints', async () => {
    const repoRoot = await createGitRepo()
    const result = await runCheckpointed(repoRoot, "printf 'after\\n' > modified.txt")
    const checkpointId = result.recoveryCheckpointId ?? ''
    const loaded = await showRecoveryCheckpoint(
      path.join(repoRoot, '.recovery-state'),
      checkpointId,
    )

    expect(loaded.manifest).toMatchObject({
      version: 2,
      backend: 'git_worktree',
      resourceKind: 'git_repository',
    })
    expect(loaded.manifest.proof).toMatchObject({
      backend: 'git_worktree',
      probeSignals: ['clean_git_worktree', 'observed_repo_local_diff'],
    })
  })

  it('records file_checkpoint backend metadata when requested', async () => {
    const repoRoot = await createGitRepo()
    const executionRoot = await mkdtemp(path.join(os.tmpdir(), 'belay-recovery-fcp-'))
    tempDirs.push(executionRoot)
    const stateDir = path.join(repoRoot, '.recovery-state')
    await writeFile(path.join(repoRoot, 'dirty.txt'), 'before\n')
    await writeFile(path.join(executionRoot, 'dirty.txt'), 'after\n')
    const checkpoint = await prepareRecoveryCheckpoint({
      stateDir,
      repoRoot,
      worktreePath: executionRoot,
      commandFingerprint: 'dirty-file-checkpoint',
      changes: [{ relativePath: 'dirty.txt', kind: 'modified' }],
      config: { ...DEFAULT_RECOVERY_CHECKPOINT, enabled: true },
      backend: 'file_checkpoint',
    })

    expect(checkpoint.manifest).toMatchObject({
      version: 2,
      backend: 'file_checkpoint',
      resourceKind: 'git_repository',
    })
    expect(checkpoint.manifest.proof).toMatchObject({
      backend: 'file_checkpoint',
      probeSignals: ['dirty_git_worktree', 'file_checkpoint', 'observed_repo_local_diff'],
    })
  })

  it('reports file-checkpoint availability and probe details in recover status', async () => {
    const repoRoot = await createGitRepo()
    await writeConfigFile(repoRoot, {
      ...DEFAULT_CONFIG_V3,
      policy: {
        ...DEFAULT_CONFIG_V3.policy,
        transactional: {
          ...DEFAULT_CONFIG_V3.policy.transactional,
          enabled: true,
          fileCheckpoint: {
            ...DEFAULT_CONFIG_V3.policy.transactional.fileCheckpoint,
            enabled: true,
          },
          checkpoint: { ...DEFAULT_RECOVERY_CHECKPOINT, enabled: true },
        },
      },
    })

    const status = await recoveryCheckpointCommand({
      targetDir: repoRoot,
      subcommand: 'status',
    })
    expect(status).toMatchObject({
      availableBackends: ['git_worktree', 'file_checkpoint'],
      fileCheckpoint: {
        enabled: true,
        allowNonGit: false,
        isolation: null,
        probe: 'unavailable',
      },
    })
    expect(status.fileCheckpoint).toBeDefined()
    if (!status.fileCheckpoint) throw new Error('missing fileCheckpoint status')
    expect(['clonefile', 'reflink', 'copy']).toContain(status.fileCheckpoint.copyStrategy)
  })

  it('skips clone probe when file checkpoint is disabled in recover status', async () => {
    const repoRoot = await createGitRepo()
    await writeConfigFile(repoRoot, DEFAULT_CONFIG_V3)

    const status = await recoveryCheckpointCommand({
      targetDir: repoRoot,
      subcommand: 'status',
    })
    expect(status.fileCheckpoint?.enabled).toBe(false)
    expect(status.fileCheckpoint?.copyStrategy).toBeUndefined()
  })

  it('restores an existing durable manifest v1 fixture', async () => {
    const repoRoot = await createGitRepo()
    await writeFile(path.join(repoRoot, 'modified.txt'), 'after\n')
    const fixture = await installRecoveryV1Fixture(repoRoot)

    await expect(
      restoreRecoveryCheckpoint(fixture.stateDir, fixture.checkpointId),
    ).resolves.toMatchObject({ changeCount: 1 })
    await expect(readFile(path.join(repoRoot, 'modified.txt'), 'utf8')).resolves.toBe('before\n')
  })

  it('restores file-to-directory and directory-to-file changes', async () => {
    const fileToDirectoryRoot = await createGitRepo()
    const fileToDirectory = await runCheckpointed(
      fileToDirectoryRoot,
      "rm modified.txt; mkdir modified.txt; printf 'nested\\n' > modified.txt/nested.txt",
    )
    expect(fileToDirectory.recoveryState).toBe('applied')
    await restoreRecoveryCheckpoint(
      path.join(fileToDirectoryRoot, '.recovery-state'),
      fileToDirectory.recoveryCheckpointId ?? '',
    )
    await expect(readFile(path.join(fileToDirectoryRoot, 'modified.txt'), 'utf8')).resolves.toBe(
      'before\n',
    )

    const directoryToFileRoot = await createGitRepo()
    await mkdir(path.join(directoryToFileRoot, 'folder'))
    await writeFile(path.join(directoryToFileRoot, 'folder', 'child.txt'), 'child\n')
    await execFileAsync('git', ['add', '.'], { cwd: directoryToFileRoot })
    await execFileAsync('git', ['commit', '-m', 'add directory'], { cwd: directoryToFileRoot })
    const directoryToFile = await runCheckpointed(
      directoryToFileRoot,
      "rm -rf folder; printf 'flat\\n' > folder",
    )
    expect(directoryToFile.recoveryState).toBe('applied')
    await restoreRecoveryCheckpoint(
      path.join(directoryToFileRoot, '.recovery-state'),
      directoryToFile.recoveryCheckpointId ?? '',
    )
    await expect(
      readFile(path.join(directoryToFileRoot, 'folder', 'child.txt'), 'utf8'),
    ).resolves.toBe('child\n')
  })

  it('restores directory mode changes', async () => {
    const repoRoot = await createGitRepo()
    const executionRoot = await mkdtemp(path.join(os.tmpdir(), 'belay-recovery-execution-'))
    tempDirs.push(executionRoot)
    const stateDir = path.join(repoRoot, '.recovery-state')
    await mkdir(path.join(repoRoot, 'mode-dir'), { mode: 0o700 })
    await mkdir(path.join(executionRoot, 'mode-dir'), { mode: 0o755 })
    const checkpoint = await prepareRecoveryCheckpoint({
      stateDir,
      repoRoot,
      worktreePath: executionRoot,
      commandFingerprint: 'directory-mode-change',
      changes: [{ relativePath: 'mode-dir', kind: 'modified' }],
      config: { ...DEFAULT_RECOVERY_CHECKPOINT, enabled: true },
    })
    await execFileAsync('chmod', ['755', path.join(repoRoot, 'mode-dir')])
    await markRecoveryCheckpointApplying(stateDir, checkpoint)
    await markRecoveryCheckpointApplied(stateDir, checkpoint)

    await restoreRecoveryCheckpoint(stateDir, checkpoint.checkpointId)

    expect((await lstat(path.join(repoRoot, 'mode-dir'))).mode & 0o777).toBe(0o700)
  })

  it('never recursively removes unmanifested directory content during restore', async () => {
    const repoRoot = await createGitRepo()
    const executionRoot = await mkdtemp(path.join(os.tmpdir(), 'belay-recovery-execution-'))
    tempDirs.push(executionRoot)
    const stateDir = path.join(repoRoot, '.recovery-state')
    await mkdir(path.join(executionRoot, 'empty-dir'), { mode: 0o755 })
    const checkpoint = await prepareRecoveryCheckpoint({
      stateDir,
      repoRoot,
      worktreePath: executionRoot,
      commandFingerprint: 'directory-addition',
      changes: [{ relativePath: 'empty-dir', kind: 'added' }],
      config: { ...DEFAULT_RECOVERY_CHECKPOINT, enabled: true },
    })
    await mkdir(path.join(repoRoot, 'empty-dir'), { mode: 0o755 })
    await markRecoveryCheckpointApplying(stateDir, checkpoint)
    await markRecoveryCheckpointApplied(stateDir, checkpoint)
    await writeFile(path.join(repoRoot, 'empty-dir', 'unmanifested.txt'), 'keep\n')

    await expect(restoreRecoveryCheckpoint(stateDir, checkpoint.checkpointId)).rejects.toThrow()
    await expect(
      readFile(path.join(repoRoot, 'empty-dir', 'unmanifested.txt'), 'utf8'),
    ).resolves.toBe('keep\n')
    expect((await showRecoveryCheckpoint(stateDir, checkpoint.checkpointId)).state.state).toBe(
      'applied',
    )
  })

  it('rejects a tampered directory hash before changing the repository', async () => {
    const repoRoot = await createGitRepo()
    const executionRoot = await mkdtemp(path.join(os.tmpdir(), 'belay-recovery-execution-'))
    tempDirs.push(executionRoot)
    const stateDir = path.join(repoRoot, '.recovery-state')
    await mkdir(path.join(repoRoot, 'mode-dir'), { mode: 0o700 })
    await mkdir(path.join(executionRoot, 'mode-dir'), { mode: 0o755 })
    const checkpoint = await prepareRecoveryCheckpoint({
      stateDir,
      repoRoot,
      worktreePath: executionRoot,
      commandFingerprint: 'tampered-directory-hash',
      changes: [{ relativePath: 'mode-dir', kind: 'modified' }],
      config: { ...DEFAULT_RECOVERY_CHECKPOINT, enabled: true },
    })
    await execFileAsync('chmod', ['755', path.join(repoRoot, 'mode-dir')])
    await markRecoveryCheckpointApplying(stateDir, checkpoint)
    await markRecoveryCheckpointApplied(stateDir, checkpoint)
    const loaded = await showRecoveryCheckpoint(stateDir, checkpoint.checkpointId)
    const entry = loaded.manifest.entries[0]
    expect(entry?.after.kind).toBe('directory')
    if (entry?.after.kind === 'directory') entry.after.hash = '0'.repeat(64)
    await rewriteArtifactBindings(loaded.artifactDir, loaded.manifest)

    await expect(restoreRecoveryCheckpoint(stateDir, checkpoint.checkpointId)).rejects.toThrow(
      'recovery_checkpoint_corrupt',
    )
    expect((await lstat(path.join(repoRoot, 'mode-dir'))).mode & 0o777).toBe(0o755)
  })

  it('rejects rebound directory modes outside the portable permission range', async () => {
    const repoRoot = await createGitRepo()
    const executionRoot = await mkdtemp(path.join(os.tmpdir(), 'belay-recovery-execution-'))
    tempDirs.push(executionRoot)
    const stateDir = path.join(repoRoot, '.recovery-state')
    await mkdir(path.join(repoRoot, 'mode-dir'), { mode: 0o700 })
    await mkdir(path.join(executionRoot, 'mode-dir'), { mode: 0o755 })
    const checkpoint = await prepareRecoveryCheckpoint({
      stateDir,
      repoRoot,
      worktreePath: executionRoot,
      commandFingerprint: 'invalid-directory-mode',
      changes: [{ relativePath: 'mode-dir', kind: 'modified' }],
      config: { ...DEFAULT_RECOVERY_CHECKPOINT, enabled: true },
    })
    await execFileAsync('chmod', ['755', path.join(repoRoot, 'mode-dir')])
    await markRecoveryCheckpointApplying(stateDir, checkpoint)
    await markRecoveryCheckpointApplied(stateDir, checkpoint)
    const loaded = await showRecoveryCheckpoint(stateDir, checkpoint.checkpointId)
    const entry = loaded.manifest.entries[0]
    expect(entry?.before.kind).toBe('directory')
    if (entry?.before.kind === 'directory') {
      entry.before.mode = 0o4755
      entry.before.hash = recoveryDirectoryHash(entry.before.mode)
    }
    await rewriteArtifactBindings(loaded.artifactDir, loaded.manifest)

    await expect(restoreRecoveryCheckpoint(stateDir, checkpoint.checkpointId)).rejects.toThrow(
      'recovery_checkpoint_corrupt',
    )
    expect((await lstat(path.join(repoRoot, 'mode-dir'))).mode & 0o777).toBe(0o755)
  })

  it('rejects rebound snapshots with unexpected fields before changing the repository', async () => {
    const repoRoot = await createGitRepo()
    const result = await runCheckpointed(repoRoot, "printf 'new\\n' > added.txt")
    const checkpointId = result.recoveryCheckpointId ?? ''
    const stateDir = path.join(repoRoot, '.recovery-state')
    const loaded = await showRecoveryCheckpoint(stateDir, checkpointId)
    const before = loaded.manifest.entries[0]?.before
    expect(before?.kind).toBe('absent')
    if (before?.kind === 'absent') {
      Object.assign(before, { unexpected: true })
    }
    await rewriteArtifactBindings(loaded.artifactDir, loaded.manifest)

    await expect(restoreRecoveryCheckpoint(stateDir, checkpointId)).rejects.toThrow(
      'recovery_checkpoint_corrupt',
    )
    await expect(readFile(path.join(repoRoot, 'added.txt'), 'utf8')).resolves.toBe('new\n')
  })

  it('binds v2 restore identity to its declared resource kind', async () => {
    const repoRoot = await createGitRepo()
    const result = await runCheckpointed(repoRoot, "printf 'after\\n' > modified.txt")
    const checkpointId = result.recoveryCheckpointId ?? ''
    const stateDir = path.join(repoRoot, '.recovery-state')
    const loaded = await showRecoveryCheckpoint(stateDir, checkpointId)
    expect(loaded.manifest.version).toBe(2)
    if (loaded.manifest.version === 2) loaded.manifest.resourceKind = 'directory'
    await rewriteArtifactBindings(loaded.artifactDir, loaded.manifest)

    await expect(restoreRecoveryCheckpoint(stateDir, checkpointId)).rejects.toThrow(
      'recovery_checkpoint_repo_mismatch',
    )
    await expect(readFile(path.join(repoRoot, 'modified.txt'), 'utf8')).resolves.toBe('after\n')
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
    const before = loaded.manifest.entries[0]?.before
    expect(before?.kind).toBe('file')
    const blob = before?.kind === 'file' ? (before.blob ?? '') : ''
    await writeFile(path.join(loaded.artifactDir, blob), 'tampered\n')

    await expect(restoreRecoveryCheckpoint(stateDir, checkpointId)).rejects.toThrow(
      'recovery_checkpoint_corrupt',
    )
    await expect(readFile(path.join(repoRoot, 'modified.txt'), 'utf8')).resolves.toBe('after\n')
  })

  it('rejects a missing pre-image blob before changing the repository', async () => {
    const repoRoot = await createGitRepo()
    const result = await runCheckpointed(repoRoot, "printf 'after\\n' > modified.txt")
    const checkpointId = result.recoveryCheckpointId ?? ''
    const stateDir = path.join(repoRoot, '.recovery-state')
    const loaded = await showRecoveryCheckpoint(stateDir, checkpointId)
    const before = loaded.manifest.entries[0]?.before
    expect(before?.kind).toBe('file')
    const blob = before?.kind === 'file' ? (before.blob ?? '') : ''
    await rm(path.join(loaded.artifactDir, blob))

    await expect(restoreRecoveryCheckpoint(stateDir, checkpointId)).rejects.toThrow(
      'recovery_checkpoint_corrupt',
    )
    await expect(readFile(path.join(repoRoot, 'modified.txt'), 'utf8')).resolves.toBe('after\n')
  })

  it('rejects a manifest changed without matching state bindings before real writes', async () => {
    const repoRoot = await createGitRepo()
    const result = await runCheckpointed(repoRoot, "printf 'after\\n' > modified.txt")
    const checkpointId = result.recoveryCheckpointId ?? ''
    const stateDir = path.join(repoRoot, '.recovery-state')
    const loaded = await showRecoveryCheckpoint(stateDir, checkpointId)
    loaded.manifest.commandFingerprint = 'tampered-command'
    await writeFile(
      path.join(loaded.artifactDir, 'manifest.json'),
      `${JSON.stringify(loaded.manifest, null, 2)}\n`,
    )

    await expect(restoreRecoveryCheckpoint(stateDir, checkpointId)).rejects.toThrow(
      'recovery_checkpoint_corrupt',
    )
    await expect(readFile(path.join(repoRoot, 'modified.txt'), 'utf8')).resolves.toBe('after\n')
  })

  it('rejects a missing manifest before changing the repository', async () => {
    const repoRoot = await createGitRepo()
    const result = await runCheckpointed(repoRoot, "printf 'after\\n' > modified.txt")
    const checkpointId = result.recoveryCheckpointId ?? ''
    const stateDir = path.join(repoRoot, '.recovery-state')
    const loaded = await showRecoveryCheckpoint(stateDir, checkpointId)
    await rm(path.join(loaded.artifactDir, 'manifest.json'))

    await expect(restoreRecoveryCheckpoint(stateDir, checkpointId)).rejects.toThrow(
      'recovery_checkpoint_corrupt',
    )
    await expect(readFile(path.join(repoRoot, 'modified.txt'), 'utf8')).resolves.toBe('after\n')
  })

  it('rejects a manifest with an invalid expiry before changing the repository', async () => {
    const repoRoot = await createGitRepo()
    const result = await runCheckpointed(repoRoot, "printf 'after\\n' > modified.txt")
    const checkpointId = result.recoveryCheckpointId ?? ''
    const stateDir = path.join(repoRoot, '.recovery-state')
    const loaded = await showRecoveryCheckpoint(stateDir, checkpointId)
    loaded.manifest.expiresAt = 'not-a-date'
    await rewriteArtifactBindings(loaded.artifactDir, loaded.manifest)

    await expect(restoreRecoveryCheckpoint(stateDir, checkpointId)).rejects.toThrow(
      'recovery_checkpoint_corrupt',
    )
    await expect(readFile(path.join(repoRoot, 'modified.txt'), 'utf8')).resolves.toBe('after\n')
  })

  it('rejects mismatched manifest and proof expiries before changing the repository', async () => {
    const repoRoot = await createGitRepo()
    const result = await runCheckpointed(repoRoot, "printf 'after\\n' > modified.txt")
    const checkpointId = result.recoveryCheckpointId ?? ''
    const stateDir = path.join(repoRoot, '.recovery-state')
    const loaded = await showRecoveryCheckpoint(stateDir, checkpointId)
    loaded.manifest.proof.expiresAt = '2020-01-01T00:00:00.000Z'
    await rewriteArtifactBindings(loaded.artifactDir, loaded.manifest)

    await expect(restoreRecoveryCheckpoint(stateDir, checkpointId)).rejects.toThrow(
      'recovery_checkpoint_corrupt',
    )
    await expect(readFile(path.join(repoRoot, 'modified.txt'), 'utf8')).resolves.toBe('after\n')
  })

  it.each([
    'git_worktree',
    'file_checkpoint',
  ] as const)('requires and consumes an exact one-shot approval before CLI restore (%s)', async (backend) => {
    const repoRoot = await createGitRepo()
    const stateDir = path.join(repoRoot, '.cursor', 'belay')
    const config = {
      ...DEFAULT_CONFIG_V3,
      controlPlane: { ...DEFAULT_CONFIG_V3.controlPlane, enabled: true, configDir: stateDir },
      policy: {
        ...DEFAULT_CONFIG_V3.policy,
        transactional: {
          ...DEFAULT_CONFIG_V3.policy.transactional,
          fileCheckpoint: {
            ...DEFAULT_CONFIG_V3.policy.transactional.fileCheckpoint,
            enabled: backend === 'file_checkpoint',
          },
          checkpoint: { ...DEFAULT_RECOVERY_CHECKPOINT, enabled: true },
        },
      },
    }
    await writeConfigFile(repoRoot, config)
    let checkpointId: string
    if (backend === 'git_worktree') {
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
      checkpointId = execution.recoveryCheckpointId ?? ''
    } else {
      const executionRoot = await mkdtemp(path.join(os.tmpdir(), 'belay-recovery-fcp-one-shot-'))
      tempDirs.push(executionRoot)
      await writeFile(path.join(executionRoot, 'modified.txt'), 'after\n')
      const checkpoint = await prepareRecoveryCheckpoint({
        stateDir,
        repoRoot,
        worktreePath: executionRoot,
        commandFingerprint: 'file-checkpoint-one-shot',
        changes: [{ relativePath: 'modified.txt', kind: 'modified' }],
        config: config.policy.transactional.checkpoint,
        backend: 'file_checkpoint',
      })
      await writeFile(path.join(repoRoot, 'modified.txt'), 'after\n')
      await markRecoveryCheckpointApplying(stateDir, checkpoint)
      await markRecoveryCheckpointApplied(stateDir, checkpoint)
      checkpointId = checkpoint.checkpointId
    }

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

  it('rejects a tampered receipt before changing the repository', async () => {
    const repoRoot = await createGitRepo()
    const result = await runCheckpointed(repoRoot, "printf 'after\\n' > modified.txt")
    const checkpointId = result.recoveryCheckpointId ?? ''
    const stateDir = path.join(repoRoot, '.recovery-state')
    const loaded = await showRecoveryCheckpoint(stateDir, checkpointId)
    const receiptPath = path.join(loaded.artifactDir, 'receipt.json')
    const receipt = JSON.parse(await readFile(receiptPath, 'utf8')) as RecoveryReceiptV1
    receipt.postStateHash = '0'.repeat(64)
    await writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`)

    await expect(restoreRecoveryCheckpoint(stateDir, checkpointId)).rejects.toThrow(
      'recovery_checkpoint_corrupt',
    )
    await expect(readFile(path.join(repoRoot, 'modified.txt'), 'utf8')).resolves.toBe('after\n')
  })

  it('does not rewrite repository nodes when the restoring state cannot be persisted', async () => {
    const repoRoot = await createGitRepo()
    const result = await runCheckpointed(repoRoot, "printf 'after\\n' > modified.txt")
    const checkpointId = result.recoveryCheckpointId ?? ''
    const stateDir = path.join(repoRoot, '.recovery-state')
    const loaded = await showRecoveryCheckpoint(stateDir, checkpointId)
    const target = path.join(repoRoot, 'modified.txt')
    const before = await lstat(target)

    await chmod(loaded.artifactDir, 0o500)
    try {
      await expect(restoreRecoveryCheckpoint(stateDir, checkpointId)).rejects.toThrow()
      const after = await lstat(target)
      expect(after.ino).toBe(before.ino)
      expect(after.mode & 0o777).toBe(before.mode & 0o777)
      await expect(readFile(target, 'utf8')).resolves.toBe('after\n')
    } finally {
      await chmod(loaded.artifactDir, 0o700)
    }
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

  it('reconciles complete before-state crashes to prepared, restored, or preserved conflict', async () => {
    const repoRoot = await createGitRepo()
    const result = await runCheckpointed(repoRoot, "printf 'after\\n' > modified.txt")
    const checkpointId = result.recoveryCheckpointId ?? ''
    const stateDir = path.join(repoRoot, '.recovery-state')
    const loaded = await showRecoveryCheckpoint(stateDir, checkpointId)
    const statePath = path.join(loaded.artifactDir, 'state.json')
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
    await expect(reconcileRecoveryCheckpoint(stateDir, checkpointId)).resolves.toBe('prepared')

    await writeFile(
      statePath,
      `${JSON.stringify({
        version: 1,
        state: 'restoring',
        updatedAt: new Date().toISOString(),
        manifestHash: loaded.manifestHash,
      })}\n`,
    )
    await expect(reconcileRecoveryCheckpoint(stateDir, checkpointId)).resolves.toBe('restored')

    await writeFile(
      statePath,
      `${JSON.stringify({
        version: 1,
        state: 'conflict',
        updatedAt: new Date().toISOString(),
        manifestHash: loaded.manifestHash,
      })}\n`,
    )
    await expect(reconcileRecoveryCheckpoint(stateDir, checkpointId)).resolves.toBe('conflict')
  })

  it('reconciles file-to-directory checkpoints across apply and restore crash states', async () => {
    const repoRoot = await createGitRepo()
    await writeFile(path.join(repoRoot, 'node'), 'flat\n')
    await execFileAsync('git', ['add', 'node'], { cwd: repoRoot })
    await execFileAsync('git', ['commit', '-m', 'add type-change fixture'], { cwd: repoRoot })
    const result = await runCheckpointed(
      repoRoot,
      "rm node; mkdir node; printf 'nested\\n' > node/child.txt",
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

    await writeFile(
      statePath,
      `${JSON.stringify({
        version: 1,
        state: 'restoring',
        updatedAt: new Date().toISOString(),
        manifestHash: loaded.manifestHash,
      })}\n`,
    )
    await expect(reconcileRecoveryCheckpoint(stateDir, checkpointId)).resolves.toBe('applied')

    await restoreRecoveryCheckpoint(stateDir, checkpointId)
    await writeFile(
      statePath,
      `${JSON.stringify({
        version: 1,
        state: 'restoring',
        updatedAt: new Date().toISOString(),
        manifestHash: loaded.manifestHash,
      })}\n`,
    )
    await expect(reconcileRecoveryCheckpoint(stateDir, checkpointId)).resolves.toBe('restored')
    await expect(readFile(path.join(repoRoot, 'node'), 'utf8')).resolves.toBe('flat\n')

    await rm(path.join(repoRoot, 'node'))
    await mkdir(path.join(repoRoot, 'node'))
    await writeFile(
      statePath,
      `${JSON.stringify({
        version: 1,
        state: 'restoring',
        updatedAt: new Date().toISOString(),
        manifestHash: loaded.manifestHash,
      })}\n`,
    )
    await expect(reconcileRecoveryCheckpoint(stateDir, checkpointId)).resolves.toBe(
      'needs_manual_repair',
    )
  })
})
