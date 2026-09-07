import { realpathSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { routeCursorHook } from '../adapters/cursor/hook-router.js'
import {
  hasDynamicProjectHookShim,
  hasLegacyProjectHookShim,
  hasManagedProjectHookShim,
} from '../adapters/cursor/project-hook-shim.js'
import { renderShellGateHook } from '../templates.js'

const tempDirs: string[] = []

afterEach(async () => {
  while (tempDirs.length > 0) {
    await rm(tempDirs.pop()!, { recursive: true, force: true })
  }
})

describe('project hook shim helpers', () => {
  it('recognizes dynamically derived project hook shims', async () => {
    const source = renderShellGateHook('cursor', { scope: 'project', repoRoot: '/ignored' })
    expect(hasDynamicProjectHookShim(source)).toBe(true)
    expect(hasLegacyProjectHookShim(source, '/ignored')).toBe(false)
  })

  it('still recognizes legacy hardcoded project hook shims', () => {
    const repoRoot = '/tmp/project'
    const source = `import { dispatchCursorHook } from '../belay/runtime/dispatcher.mjs'

await dispatchCursorHook({
  origin: ${JSON.stringify({ scope: 'project', repoRoot })},
  kind: "shell-gate",
  eventName: "beforeShellExecution",
})
`
    expect(hasLegacyProjectHookShim(source, repoRoot)).toBe(true)
    expect(hasDynamicProjectHookShim(source)).toBe(false)
    expect(hasManagedProjectHookShim(source, repoRoot)).toBe(true)
  })
})

describe('dynamic project hook shims and routing', () => {
  it('treats a shim in the opened repo as callable even when legacy checks used another worktree path', async () => {
    const repoRoot = await mkdtemp(path.join(os.tmpdir(), 'belay-dynamic-shim-route-'))
    tempDirs.push(repoRoot)
    const hooksDir = path.join(repoRoot, '.cursor', 'hooks')
    const runtimeDir = path.join(repoRoot, '.cursor', 'belay', 'runtime')
    await mkdir(hooksDir, { recursive: true })
    await mkdir(runtimeDir, { recursive: true })
    await writeFile(path.join(runtimeDir, 'dispatcher.mjs'), 'export {}\n')
    await writeFile(path.join(runtimeDir, 'core.mjs'), 'export {}\n')
    await writeFile(path.join(hooksDir, 'belay-runner'), '#!/bin/sh\n', { mode: 0o755 })
    const runnerPath = realpathSync(path.join(hooksDir, 'belay-runner'))
    await writeFile(
      path.join(hooksDir, 'belay-shell-gate.mjs'),
      renderShellGateHook('cursor', {
        scope: 'project',
        repoRoot: '/tmp/other-worktree',
      }),
    )
    await writeFile(
      path.join(repoRoot, '.cursor', 'hooks.json'),
      `${JSON.stringify(
        {
          version: 1,
          hooks: {
            beforeShellExecution: [
              {
                command: `'${runnerPath.replaceAll("'", "'\\''")}' belay-shell-gate`,
                failClosed: true,
              },
            ],
          },
        },
        null,
        2,
      )}\n`,
    )
    await writeFile(
      path.join(repoRoot, '.cursor', 'belay.config.json'),
      `${JSON.stringify({ version: 4, installScope: 'project' })}\n`,
    )
    await mkdir(path.join(repoRoot, '.git'))

    const canonicalRoot = realpathSync(repoRoot)
    const route = routeCursorHook({
      origin: { scope: 'global' },
      kind: 'shell-gate',
      payload: { cwd: canonicalRoot, workspace_roots: [canonicalRoot], command: 'ls' },
      eventName: 'beforeShellExecution',
    })

    expect(route).toEqual({ decision: 'neutral' })
  })
})
