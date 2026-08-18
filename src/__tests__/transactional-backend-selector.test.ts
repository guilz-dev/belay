import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'

import { afterEach, describe, expect, it } from 'vitest'
import { cursorAdapter } from '../adapters/cursor/adapter.js'
import { protectedArtifactRoots } from '../adapters/layouts/protected-paths.js'
import type { BoundaryAttestation, BoundaryDriverId } from '../core/capability/attestation.js'
import { DEFAULT_CONFIG_V3 } from '../core/config.js'
import {
  FILE_CHECKPOINT_DISABLED,
  FILE_CHECKPOINT_DURABLE_REQUIRED,
  FILE_CHECKPOINT_ISOLATION_UNAVAILABLE,
  FILE_CHECKPOINT_NON_GIT_DISABLED,
  probeTransactionalBackends,
  selectTransactionalBackend,
} from '../core/transactional/backend-selector.js'

const execFileAsync = promisify(execFile)
const tempDirs: string[] = []

async function createGitRepo(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'belay-tx-selector-'))
  tempDirs.push(dir)
  await execFileAsync('git', ['init'], { cwd: dir })
  await execFileAsync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir })
  await execFileAsync('git', ['config', 'user.name', 'Test'], { cwd: dir })
  await writeFile(path.join(dir, 'README.md'), '# test\n')
  await execFileAsync('git', ['add', 'README.md'], { cwd: dir })
  await execFileAsync('git', ['commit', '-m', 'init'], { cwd: dir })
  return dir
}

function backendContext(
  repoRoot: string,
  overrides?: {
    fileCheckpoint?: Partial<typeof DEFAULT_CONFIG_V3.policy.transactional.fileCheckpoint>
    durableCheckpointEnabled?: boolean
    dirtyIgnoreRoots?: string[]
    boundaryAttestation?: BoundaryAttestation | null
    boundaryAttestationFresh?: boolean
    boundaryDriverId?: BoundaryDriverId
  },
) {
  return {
    repoRoot,
    stateDir: path.join(repoRoot, '.cursor', 'belay', 'transactional'),
    cwd: repoRoot,
    dirtyIgnoreRoots: overrides?.dirtyIgnoreRoots,
    fileCheckpoint: {
      ...DEFAULT_CONFIG_V3.policy.transactional.fileCheckpoint,
      ...overrides?.fileCheckpoint,
    },
    durableCheckpointEnabled: overrides?.durableCheckpointEnabled ?? false,
    boundaryAttestation: overrides?.boundaryAttestation ?? null,
    boundaryAttestationFresh: overrides?.boundaryAttestationFresh ?? false,
    boundaryDriverId: overrides?.boundaryDriverId,
  }
}

function containerIsolationAttestation(
  overrides?: Partial<BoundaryAttestation>,
): BoundaryAttestation {
  return {
    version: 1,
    driver: 'container',
    probedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    deniesUngrantedEffects: true,
    materializesGrants: true,
    isolatesWorkspaceMounts: true,
    probeSignals: ['docker', 'workspace-mount-isolation'],
    ...overrides,
  }
}

describe('transactional backend selector', () => {
  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
  })

  it('selects git_worktree for a clean Git repository', async () => {
    const repoRoot = await createGitRepo()
    const selection = await selectTransactionalBackend(backendContext(repoRoot))

    expect(selection.backend?.id).toBe('git_worktree')
    expect(selection.probe.eligible).toBe(true)
    expect(selection.skipReason).toBeUndefined()
  })

  it('fail-closes dirty Git when file checkpoint is disabled', async () => {
    const repoRoot = await createGitRepo()
    await writeFile(path.join(repoRoot, 'README.md'), '# dirty\n')

    const selection = await selectTransactionalBackend(backendContext(repoRoot))

    expect(selection.backend).toBeNull()
    expect(selection.skipReason).toBe('dirty_worktree')
    expect(selection.probe.reason).toBe(FILE_CHECKPOINT_DISABLED)
    expect(selection.probe.signals).toContain('dirty_git_worktree')
  })

  it('requires durable checkpointing when file checkpoint is enabled on dirty Git', async () => {
    const repoRoot = await createGitRepo()
    await writeFile(path.join(repoRoot, 'README.md'), '# dirty\n')

    const selection = await selectTransactionalBackend(
      backendContext(repoRoot, {
        fileCheckpoint: { enabled: true },
        durableCheckpointEnabled: false,
      }),
    )

    expect(selection.backend).toBeNull()
    expect(selection.skipReason).toBe('dirty_worktree')
    expect(selection.probe.reason).toBe(FILE_CHECKPOINT_DURABLE_REQUIRED)
  })

  it('selects file_checkpoint when prerequisites are met on dirty Git', async () => {
    const repoRoot = await createGitRepo()
    await writeFile(path.join(repoRoot, 'README.md'), '# dirty\n')

    const selection = await selectTransactionalBackend(
      backendContext(repoRoot, {
        fileCheckpoint: { enabled: true },
        durableCheckpointEnabled: true,
        boundaryAttestation: containerIsolationAttestation(),
        boundaryAttestationFresh: true,
        boundaryDriverId: 'container',
      }),
    )

    expect(selection.backend?.id).toBe('file_checkpoint')
    expect(selection.probe.eligible).toBe(true)
    expect(selection.probe.signals).toContain('dirty_git_file_checkpoint')
    expect(selection.skipReason).toBeUndefined()
  })

  it('requires attested workspace isolation before file checkpoint on dirty Git', async () => {
    const repoRoot = await createGitRepo()
    await writeFile(path.join(repoRoot, 'README.md'), '# dirty\n')

    const selection = await selectTransactionalBackend(
      backendContext(repoRoot, {
        fileCheckpoint: { enabled: true },
        durableCheckpointEnabled: true,
        boundaryAttestation: {
          version: 1,
          driver: 'host-integration',
          probedAt: new Date().toISOString(),
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
          deniesUngrantedEffects: false,
          materializesGrants: false,
          isolatesWorkspaceMounts: false,
          probeSignals: ['host-integration'],
        },
        boundaryAttestationFresh: true,
        boundaryDriverId: 'host-integration',
      }),
    )

    expect(selection.probe.reason).toBe(FILE_CHECKPOINT_ISOLATION_UNAVAILABLE)
    expect(selection.probe.signals).toContain('isolation_unavailable')
  })

  it('rejects attestation when driver id does not match resolved boundary driver', async () => {
    const repoRoot = await createGitRepo()
    await writeFile(path.join(repoRoot, 'README.md'), '# dirty\n')

    const selection = await selectTransactionalBackend(
      backendContext(repoRoot, {
        fileCheckpoint: { enabled: true },
        durableCheckpointEnabled: true,
        boundaryAttestation: containerIsolationAttestation(),
        boundaryAttestationFresh: true,
        boundaryDriverId: 'host-integration',
      }),
    )

    expect(selection.probe.reason).toBe(FILE_CHECKPOINT_ISOLATION_UNAVAILABLE)
  })

  it('rejects stale boundary attestations for file checkpoint', async () => {
    const repoRoot = await createGitRepo()
    await writeFile(path.join(repoRoot, 'README.md'), '# dirty\n')

    const selection = await selectTransactionalBackend(
      backendContext(repoRoot, {
        fileCheckpoint: { enabled: true },
        durableCheckpointEnabled: true,
        boundaryAttestation: {
          ...containerIsolationAttestation(),
          expiresAt: new Date(Date.now() - 1_000).toISOString(),
        },
        boundaryAttestationFresh: false,
        boundaryDriverId: 'container',
      }),
    )

    expect(selection.probe.reason).toBe(FILE_CHECKPOINT_ISOLATION_UNAVAILABLE)
  })

  it('accepts a current workspace-isolation attestation without full grant enforcement', async () => {
    const repoRoot = await createGitRepo()
    await writeFile(path.join(repoRoot, 'README.md'), '# dirty\n')

    const selection = await selectTransactionalBackend(
      backendContext(repoRoot, {
        fileCheckpoint: { enabled: true },
        durableCheckpointEnabled: true,
        boundaryAttestation: {
          ...containerIsolationAttestation(),
          deniesUngrantedEffects: false,
          materializesGrants: false,
        },
        boundaryAttestationFresh: false,
        boundaryDriverId: 'container',
      }),
    )

    expect(selection.backend?.id).toBe('file_checkpoint')
    expect(selection.probe.eligible).toBe(true)
  })

  it('fail-closes non-Git workspaces when file checkpoint is disabled', async () => {
    const repoRoot = await mkdtemp(path.join(os.tmpdir(), 'belay-tx-nogit-'))
    tempDirs.push(repoRoot)
    await writeFile(path.join(repoRoot, 'README.md'), '# plain\n')

    const selection = await selectTransactionalBackend(backendContext(repoRoot))

    expect(selection.backend).toBeNull()
    expect(selection.skipReason).toBe('git_worktree_unavailable')
    expect(selection.probe.reason).toBe(FILE_CHECKPOINT_DISABLED)
    expect(selection.probe.signals).toContain('non_git_workspace')
  })

  it('requires allowNonGit for non-Git workspaces even when file checkpoint is enabled', async () => {
    const repoRoot = await mkdtemp(path.join(os.tmpdir(), 'belay-tx-nogit-'))
    tempDirs.push(repoRoot)
    await writeFile(path.join(repoRoot, 'README.md'), '# plain\n')

    const selection = await selectTransactionalBackend(
      backendContext(repoRoot, {
        fileCheckpoint: { enabled: true, allowNonGit: false },
        durableCheckpointEnabled: true,
      }),
    )

    expect(selection.backend).toBeNull()
    expect(selection.probe.reason).toBe(FILE_CHECKPOINT_NON_GIT_DISABLED)
  })

  it('selects file_checkpoint when non-Git prerequisites are met', async () => {
    const repoRoot = await mkdtemp(path.join(os.tmpdir(), 'belay-tx-nogit-'))
    tempDirs.push(repoRoot)
    await writeFile(path.join(repoRoot, 'README.md'), '# plain\n')

    const selection = await selectTransactionalBackend(
      backendContext(repoRoot, {
        fileCheckpoint: { enabled: true, allowNonGit: true },
        durableCheckpointEnabled: true,
        boundaryAttestation: containerIsolationAttestation(),
        boundaryAttestationFresh: true,
        boundaryDriverId: 'container',
      }),
    )

    expect(selection.backend?.id).toBe('file_checkpoint')
    expect(selection.probe.eligible).toBe(true)
    expect(selection.probe.signals).toContain('non_git_file_checkpoint')
    expect(selection.skipReason).toBeUndefined()
  })

  it('returns non-git probes from file_checkpoint backend when enabled', async () => {
    const repoRoot = await mkdtemp(path.join(os.tmpdir(), 'belay-tx-nogit-'))
    tempDirs.push(repoRoot)
    await writeFile(path.join(repoRoot, 'README.md'), '# plain\n')

    const probes = await probeTransactionalBackends(
      backendContext(repoRoot, {
        fileCheckpoint: { enabled: true, allowNonGit: true },
        durableCheckpointEnabled: true,
        boundaryAttestation: containerIsolationAttestation(),
        boundaryAttestationFresh: true,
        boundaryDriverId: 'container',
      }),
    )

    expect(probes[1]?.eligible).toBe(true)
    expect(probes[1]?.resourceKind).toBe('directory')
    expect(probes[1]?.signals).toContain('non_git_workspace')
    expect(probes[1]?.signals).toContain('non_git_file_checkpoint')
  })

  it('treats belay init artifacts as clean when dirtyIgnoreRoots is provided', async () => {
    const repoRoot = await createGitRepo()
    await mkdir(path.join(repoRoot, '.cursor', 'belay'), { recursive: true })
    await writeFile(path.join(repoRoot, '.cursor', 'belay', 'audit.ndjson'), '')
    await writeFile(path.join(repoRoot, '.cursor', 'belay.config.json'), '{}\n')

    const selection = await selectTransactionalBackend(
      backendContext(repoRoot, {
        dirtyIgnoreRoots: protectedArtifactRoots(cursorAdapter.layout, repoRoot, null),
      }),
    )

    expect(selection.backend?.id).toBe('git_worktree')
    expect(selection.probe.eligible).toBe(true)
  })

  it('returns probes for both backends', async () => {
    const repoRoot = await createGitRepo()
    await writeFile(path.join(repoRoot, 'README.md'), '# dirty\n')

    const probes = await probeTransactionalBackends(backendContext(repoRoot))

    expect(probes).toHaveLength(2)
    expect(probes[0]?.backend).toBe('git_worktree')
    expect(probes[0]?.eligible).toBe(false)
    expect(probes[1]?.backend).toBe('file_checkpoint')
    expect(probes[1]?.reason).toBe(FILE_CHECKPOINT_DISABLED)
  })

  it('does not label clean Git workspaces as dirty in file checkpoint probes', async () => {
    const repoRoot = await createGitRepo()

    const probes = await probeTransactionalBackends(backendContext(repoRoot))

    expect(probes[1]?.signals).toEqual(['git_repository'])
    expect(probes[1]?.resourceKind).toBe('git_repository')
    expect(probes[1]?.signals).not.toContain('dirty_git_worktree')
  })
})
