import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { cursorLayout } from '../adapters/layouts/cursor.js'
import { findRepoRoot } from '../adapters/shared/repo-root.js'

const tempDirs: string[] = []

async function createTempDir(prefix: string) {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

describe('findRepoRoot', () => {
  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
  })

  it('does not treat HOME/.cursor without belay.config.json as a repo root', async () => {
    const homeLike = await createTempDir('belay-home-like-')
    await mkdir(path.join(homeLike, '.cursor'), { recursive: true })
    const nested = path.join(homeLike, 'product', 'repo')
    await mkdir(path.join(nested, '.git'), { recursive: true })
    await mkdir(path.join(nested, '.cursor'), { recursive: true })
    await writeFile(
      path.join(nested, '.cursor', 'belay.config.json'),
      `${JSON.stringify({ version: 4 }, null, 2)}\n`,
    )

    const repoRoot = findRepoRoot(nested, cursorLayout)
    expect(repoRoot).toBe(path.resolve(nested))
    expect(repoRoot).not.toBe(path.resolve(homeLike))
  })

  it('accepts .cursor when belay.config.json is present', async () => {
    const repoRoot = await createTempDir('belay-cursor-marker-')
    await mkdir(path.join(repoRoot, '.cursor'), { recursive: true })
    await writeFile(
      path.join(repoRoot, '.cursor', 'belay.config.json'),
      `${JSON.stringify({ version: 4 }, null, 2)}\n`,
    )

    expect(findRepoRoot(repoRoot, cursorLayout)).toBe(path.resolve(repoRoot))
  })

  it('prefers .git over .cursor at the same directory level', async () => {
    const repoRoot = await createTempDir('belay-git-priority-')
    await mkdir(path.join(repoRoot, '.git'), { recursive: true })
    await mkdir(path.join(repoRoot, '.cursor'), { recursive: true })
    await writeFile(
      path.join(repoRoot, '.cursor', 'belay.config.json'),
      `${JSON.stringify({ version: 4 }, null, 2)}\n`,
    )

    expect(findRepoRoot(repoRoot, cursorLayout)).toBe(path.resolve(repoRoot))
    expect(existsSync(path.join(repoRoot, '.git'))).toBe(true)
  })
})
