import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'

import { afterEach, describe, expect, it } from 'vitest'
import { cursorAdapter } from '../adapters/cursor/adapter.js'
import { protectedArtifactRoots } from '../adapters/layouts/protected-paths.js'
import { DEFAULT_CONFIG_V3 } from '../core/config.js'
import {
  FILE_CHECKPOINT_DISABLED,
  FILE_CHECKPOINT_DURABLE_REQUIRED,
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
})
