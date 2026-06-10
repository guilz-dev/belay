import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { relativeWithinRepo } from '../core/path-utils.js'

const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

describe('relativeWithinRepo', () => {
  it('resolves symlinked paths inside the repository (R5)', async () => {
    const repoRoot = await mkdtemp(path.join(os.tmpdir(), 'belay-repo-'))
    tempDirs.push(repoRoot)
    const realDir = path.join(repoRoot, 'real')
    const linkPath = path.join(repoRoot, 'link.txt')
    await mkdir(realDir, { recursive: true })
    await writeFile(path.join(realDir, 'secret.txt'), 'x')
    await symlink(path.join(realDir, 'secret.txt'), linkPath)

    expect(relativeWithinRepo(repoRoot, linkPath)).toBe(path.join('real', 'secret.txt'))
  })

  it('treats symlink escape targets as outside the repo', async () => {
    const outsideDir = await mkdtemp(path.join(os.tmpdir(), 'belay-out-'))
    tempDirs.push(outsideDir)
    const repoRoot = await mkdtemp(path.join(os.tmpdir(), 'belay-repo2-'))
    tempDirs.push(repoRoot)
    const outsideFile = path.join(outsideDir, 'outside.txt')
    const linkPath = path.join(repoRoot, 'escape.txt')
    await writeFile(outsideFile, 'x')
    await symlink(outsideFile, linkPath)

    expect(relativeWithinRepo(repoRoot, linkPath)).toBeNull()
  })
})
