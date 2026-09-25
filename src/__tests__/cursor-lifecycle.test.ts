import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import type { ScopedPaths } from '../adapters/layouts/scope.js'
import {
  clearCursorDisableMarker,
  cursorLifecycleLockPaths,
  cursorLifecyclePaths,
  readCursorDisableMarker,
  withCursorLifecycleLocks,
  writeCursorDisableMarker,
} from '../installer/cursor-lifecycle.js'

const tempDirs: string[] = []

async function createPaths(scope: 'project' | 'global' = 'project'): Promise<ScopedPaths> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'belay-cursor-lifecycle-'))
  tempDirs.push(root)
  const agentDir = path.join(root, '.cursor')
  return {
    scope,
    repoRoot: root,
    configPath: path.join(agentDir, 'belay.config.json'),
    hooksSettingsPath: path.join(agentDir, 'hooks.json'),
    hooksDir: path.join(agentDir, 'hooks'),
    runtimeDir: path.join(agentDir, 'belay', 'runtime'),
    repoLocalStateDir: path.join(agentDir, 'belay'),
    skillsDir: path.join(agentDir, 'skills', 'belay'),
    commandsDir: path.join(agentDir, 'commands'),
  }
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

describe('Cursor lifecycle ownership', () => {
  it('canonicalizes, sorts, and deduplicates lock paths', async () => {
    const first = await createPaths()
    const second = await createPaths('global')

    const lockPaths = cursorLifecycleLockPaths([second, first, first])

    expect(lockPaths).toEqual([...new Set(lockPaths)].sort())
    expect(lockPaths).toHaveLength(2)
  })

  it('times out without deleting a live lock owner', async () => {
    const paths = await createPaths()
    const lifecycle = cursorLifecyclePaths(paths)
    await mkdir(lifecycle.lockDir, { recursive: true })
    await writeFile(
      lifecycle.lockOwnerPath,
      `${JSON.stringify({ schemaVersion: 1, pid: process.pid, token: 'live-owner' })}\n`,
    )

    await expect(
      withCursorLifecycleLocks(
        [paths],
        { operation: 'upgrade', repoRoot: paths.repoRoot, scope: paths.scope },
        async () => undefined,
        { timeoutMs: 30, retryMs: 5 },
      ),
    ).rejects.toThrow(/lifecycle lock.*timed out/i)
    await expect(readFile(lifecycle.lockOwnerPath, 'utf8')).resolves.toContain('live-owner')
  })

  it('recovers a lock only when its recorded PID is dead', async () => {
    const paths = await createPaths()
    const lifecycle = cursorLifecyclePaths(paths)
    await mkdir(lifecycle.lockDir, { recursive: true })
    await writeFile(
      lifecycle.lockOwnerPath,
      `${JSON.stringify({ schemaVersion: 1, pid: 2_147_483_647, token: 'dead-owner' })}\n`,
    )

    let entered = false
    await withCursorLifecycleLocks(
      [paths],
      { operation: 'upgrade', repoRoot: paths.repoRoot, scope: paths.scope },
      async () => {
        entered = true
      },
      { timeoutMs: 250, retryMs: 5 },
    )

    expect(entered).toBe(true)
    await expect(readFile(lifecycle.lockOwnerPath, 'utf8')).rejects.toMatchObject({
      code: 'ENOENT',
    })
  })

  it('does not release a lock whose owner token changed', async () => {
    const paths = await createPaths()
    const lifecycle = cursorLifecyclePaths(paths)

    await withCursorLifecycleLocks(
      [paths],
      { operation: 'upgrade', repoRoot: paths.repoRoot, scope: paths.scope },
      async () => {
        await writeFile(
          lifecycle.lockOwnerPath,
          `${JSON.stringify({ schemaVersion: 1, pid: process.pid, token: 'replacement' })}\n`,
        )
      },
    )

    await expect(readFile(lifecycle.lockOwnerPath, 'utf8')).resolves.toContain('replacement')
  })

  it('writes and clears an uninstall tombstone atomically', async () => {
    const paths = await createPaths('global')

    await writeCursorDisableMarker(paths, {
      operationId: 'op-uninstall',
      repoRoot: paths.repoRoot,
      scope: 'global',
    })

    await expect(readCursorDisableMarker(paths)).resolves.toMatchObject({
      schemaVersion: 1,
      operationId: 'op-uninstall',
      pid: process.pid,
      scope: 'global',
    })
    await clearCursorDisableMarker(paths)
    await expect(readCursorDisableMarker(paths)).resolves.toBeNull()
  })

  it('records start and result events outside the removable runtime directory', async () => {
    const paths = await createPaths()
    const lifecycle = cursorLifecyclePaths(paths)

    await withCursorLifecycleLocks(
      [paths, paths],
      { operation: 'init', repoRoot: paths.repoRoot, scope: paths.scope },
      async () => undefined,
    )

    const events = (await readFile(lifecycle.logPath, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>)
    expect(events).toHaveLength(2)
    expect(events.map((event) => event.phase)).toEqual(['start', 'result'])
    expect(events[1]).toMatchObject({ outcome: 'success', operation: 'init', pid: process.pid })
    expect(path.dirname(lifecycle.logPath)).toBe(
      await realpath(path.dirname(paths.hooksSettingsPath)),
    )
    expect(lifecycle.logPath.startsWith(paths.runtimeDir)).toBe(false)
  })
})
