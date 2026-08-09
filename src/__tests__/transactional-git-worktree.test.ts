import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'
import { cursorAdapter } from '../adapters/cursor/adapter.js'
import { protectedArtifactRoots } from '../adapters/layouts/protected-paths.js'
import {
  applyObservedChanges,
  buildObservedChangesFromTransactional,
  TRANSACTIONAL_APPLY_TOCTOU,
} from '../core/transactional/apply-observed-changes.js'
import {
  applyWorktreeChanges,
  isDirtyWorktree,
  resolveWorktreeCwd,
} from '../core/transactional/git-worktree.js'

const execFileAsync = promisify(execFile)
const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

async function createGitRepo(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'belay-tx-dirty-'))
  tempDirs.push(dir)
  await execFileAsync('git', ['init'], { cwd: dir })
  await execFileAsync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir })
  await execFileAsync('git', ['config', 'user.name', 'Test'], { cwd: dir })
  await writeFile(path.join(dir, 'README.md'), '# test\n')
  await execFileAsync('git', ['add', 'README.md'], { cwd: dir })
  await execFileAsync('git', ['commit', '-m', 'init'], { cwd: dir })
  return dir
}

describe('transactional git worktree helpers', () => {
  it('maps cwd through symlinked repo roots into the worktree', async () => {
    const base = await mkdtemp(path.join(os.tmpdir(), 'belay-tx-cwd-'))
    tempDirs.push(base)
    const privateRoot = path.join(base, 'private')
    const varLink = path.join(base, 'var')
    await mkdir(privateRoot, { recursive: true })
    await symlink(privateRoot, varLink)
    const repoRoot = path.join(varLink, 'project')
    const worktreePath = path.join(privateRoot, 'project', 'worktree')
    await mkdir(path.join(repoRoot, 'src'), { recursive: true })
    await mkdir(worktreePath, { recursive: true })

    const mapped = resolveWorktreeCwd(repoRoot, worktreePath, path.join(repoRoot, 'src'))
    expect(mapped).toBe(path.join(worktreePath, 'src'))
  })

  it('rolls back earlier files when a later apply step fails', async () => {
    const repoRoot = await mkdtemp(path.join(os.tmpdir(), 'belay-tx-apply-'))
    tempDirs.push(repoRoot)
    const worktreePath = await mkdtemp(path.join(os.tmpdir(), 'belay-tx-wt-'))
    tempDirs.push(worktreePath)

    await writeFile(path.join(repoRoot, 'a.txt'), 'original\n')
    await writeFile(path.join(worktreePath, 'a.txt'), 'changed\n')
    await writeFile(path.join(worktreePath, 'b.txt'), 'new\n')
    await mkdir(path.join(repoRoot, 'b.txt'))

    await expect(
      applyWorktreeChanges(worktreePath, repoRoot, [
        { relativePath: 'a.txt', kind: 'modified' },
        { relativePath: 'b.txt', kind: 'added' },
      ]),
    ).rejects.toThrow()

    await expect(readFile(path.join(repoRoot, 'a.txt'), 'utf8')).resolves.toBe('original\n')
  })

  it('ignores untracked belay-managed paths in dirty-worktree checks', async () => {
    const repoRoot = await createGitRepo()
    const ignoreRoots = protectedArtifactRoots(cursorAdapter.layout, repoRoot, null)
    await mkdir(path.join(repoRoot, '.cursor', 'belay'), { recursive: true })
    await writeFile(path.join(repoRoot, '.cursor', 'belay', 'audit.ndjson'), '')
    await writeFile(path.join(repoRoot, '.cursor', 'belay.config.json'), '{}\n')

    expect(await isDirtyWorktree(repoRoot)).toBe(true)
    expect(await isDirtyWorktree(repoRoot, { ignoreRoots })).toBe(false)

    await writeFile(path.join(repoRoot, 'README.md'), '# dirty\n')
    expect(await isDirtyWorktree(repoRoot, { ignoreRoots })).toBe(true)
  })

  it('rejects apply when repo files changed after observation snapshot', async () => {
    const repoRoot = await mkdtemp(path.join(os.tmpdir(), 'belay-tx-toctou-'))
    tempDirs.push(repoRoot)
    const worktreePath = await mkdtemp(path.join(os.tmpdir(), 'belay-tx-toctou-wt-'))
    tempDirs.push(worktreePath)

    await writeFile(path.join(repoRoot, 'a.txt'), 'original\n')
    await writeFile(path.join(worktreePath, 'a.txt'), 'changed\n')
    const changes = [{ relativePath: 'a.txt', kind: 'modified' as const }]
    const observed = await buildObservedChangesFromTransactional(repoRoot, worktreePath, changes)

    await writeFile(path.join(repoRoot, 'a.txt'), 'raced\n')

    await expect(
      applyObservedChanges({
        sourceRoot: worktreePath,
        targetRoot: repoRoot,
        changes: observed,
      }),
    ).rejects.toThrow(TRANSACTIONAL_APPLY_TOCTOU)
    await expect(readFile(path.join(repoRoot, 'a.txt'), 'utf8')).resolves.toBe('raced\n')
  })
})
