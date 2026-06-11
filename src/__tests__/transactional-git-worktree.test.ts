import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'
import { applyWorktreeChanges, resolveWorktreeCwd } from '../core/transactional/git-worktree.js'

const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

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
})
