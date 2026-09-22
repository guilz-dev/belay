import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { findCursorRoutingRepoRoot } from '../adapters/cursor/routing-layout.js'
import { resolveCommandTarget } from '../config-io.js'

const tempDirs: string[] = []

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()
    if (dir) {
      await import('node:fs/promises').then(({ rm }) => rm(dir, { recursive: true, force: true }))
    }
  }
})

async function makeTempRoot(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'belay-routing-'))
  tempDirs.push(dir)
  return dir
}

describe('findCursorRoutingRepoRoot', () => {
  it('walks up to parent with .cursor/belay.config.json', async () => {
    const anchor = await makeTempRoot()
    const child = path.join(anchor, 'child')
    await mkdir(path.join(anchor, '.cursor'), { recursive: true })
    await mkdir(child, { recursive: true })
    await writeFile(path.join(anchor, '.cursor', 'belay.config.json'), '{}')
    expect(findCursorRoutingRepoRoot(child)).toBe(anchor)
    expect(resolveCommandTarget(child, 'cursor').effectiveRepoRoot).toBe(anchor)
  })

  it('stops at child repo when it has its own config', async () => {
    const parent = await makeTempRoot()
    const child = path.join(parent, 'nested')
    await mkdir(path.join(parent, '.cursor'), { recursive: true })
    await mkdir(path.join(child, '.cursor'), { recursive: true })
    await writeFile(path.join(parent, '.cursor', 'belay.config.json'), '{}')
    await writeFile(path.join(child, '.cursor', 'belay.config.json'), '{}')
    expect(findCursorRoutingRepoRoot(child)).toBe(child)
  })

  it('returns start path when no routing markers exist', async () => {
    const lone = await makeTempRoot()
    const inner = path.join(lone, 'deep')
    await mkdir(inner, { recursive: true })
    expect(findCursorRoutingRepoRoot(inner)).toBe(inner)
  })
})
