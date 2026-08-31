import { realpathSync } from 'node:fs'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { routeCursorHook } from '../adapters/cursor/hook-router.js'

const tempDirs: string[] = []

async function createTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

async function installProjectHook(
  repoRoot: string,
  hookFile: string,
  installScope: 'project' | 'global' = 'project',
): Promise<void> {
  await mkdir(path.join(repoRoot, '.git'), { recursive: true })
  await mkdir(path.join(repoRoot, '.cursor', 'hooks'), { recursive: true })
  await mkdir(path.join(repoRoot, '.cursor', 'belay', 'runtime'), { recursive: true })
  await writeFile(
    path.join(repoRoot, '.cursor', 'belay.config.json'),
    `${JSON.stringify({ installScope })}\n`,
  )
  await writeFile(path.join(repoRoot, '.cursor', 'hooks', hookFile), '')
  await writeFile(path.join(repoRoot, '.cursor', 'hooks', 'belay-runner'), '')
  await writeFile(path.join(repoRoot, '.cursor', 'belay', 'runtime', 'core.mjs'), '')
}

describe('routeCursorHook', () => {
  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
  })

  it.each([
    {
      name: 'executes a complete matching project shell gate',
      installScope: 'project' as const,
      origin: (repoRoot: string) => ({ scope: 'project' as const, repoRoot }),
    },
    {
      name: 'executes a global install only from the global origin',
      installScope: 'global' as const,
      origin: () => ({ scope: 'global' as const }),
    },
  ])('$name', async ({ installScope, origin }) => {
    const repoRoot = await createTempDir('belay-cursor-project-route-')
    const actionDir = path.join(repoRoot, 'packages', 'app')
    await mkdir(actionDir, { recursive: true })
    await installProjectHook(repoRoot, 'belay-shell-gate.mjs', installScope)

    expect(
      routeCursorHook({
        origin: origin(repoRoot),
        kind: 'shell-gate',
        payload: { cwd: actionDir },
      }),
    ).toEqual({ decision: 'execute', repoRoot: realpathSync(repoRoot) })
  })

  it.each([
    {
      kind: 'before-submit' as const,
      hookFile: 'belay-before-submit.mjs',
      payload: (actionDir: string, otherDir: string) => ({
        tool_input: { working_directory: actionDir },
        cwd: otherDir,
      }),
    },
  ])('uses the payload-first working directory for $kind', async ({ kind, hookFile, payload }) => {
    const repoRoot = await createTempDir('belay-cursor-project-route-')
    const otherRepoRoot = await createTempDir('belay-cursor-other-route-')
    const actionDir = path.join(repoRoot, 'packages', 'app')
    const otherDir = path.join(otherRepoRoot, 'packages', 'app')
    await Promise.all([mkdir(actionDir, { recursive: true }), mkdir(otherDir, { recursive: true })])
    await installProjectHook(repoRoot, hookFile)

    expect(
      routeCursorHook({
        origin: { scope: 'project', repoRoot },
        kind,
        payload: payload(actionDir, otherDir),
      }),
    ).toEqual({ decision: 'execute', repoRoot: realpathSync(repoRoot) })
  })

  it.each([
    {
      kind: 'tool-gate' as const,
      hookFile: 'belay-tool-gate.mjs',
      payload: (actionDir: string) => ({ tool_name: 'Write', cwd: actionDir }),
    },
  ])('executes a complete matching project $kind', async ({ kind, hookFile, payload }) => {
    const repoRoot = await createTempDir('belay-cursor-project-route-')
    const actionDir = path.join(repoRoot, 'packages', 'app')
    await mkdir(actionDir, { recursive: true })
    await installProjectHook(repoRoot, hookFile)

    expect(
      routeCursorHook({
        origin: { scope: 'project', repoRoot },
        kind,
        payload: payload(actionDir),
      }),
    ).toEqual({ decision: 'execute', repoRoot: realpathSync(repoRoot) })
  })

  it.each([
    {
      name: 'uses a Shell working directory before a conflicting top-level cwd',
      payload: (actionDir: string, otherDir: string) => ({
        tool_input: { working_directory: actionDir },
        cwd: otherDir,
      }),
    },
  ])('$name', async ({ payload }) => {
    const repoRoot = await createTempDir('belay-cursor-project-route-')
    const otherRepoRoot = await createTempDir('belay-cursor-other-route-')
    const actionDir = path.join(repoRoot, 'packages', 'app')
    const otherDir = path.join(otherRepoRoot, 'packages', 'app')
    await Promise.all([mkdir(actionDir, { recursive: true }), mkdir(otherDir, { recursive: true })])
    await installProjectHook(repoRoot, 'belay-shell-gate.mjs')

    expect(
      routeCursorHook({
        origin: { scope: 'project', repoRoot },
        kind: 'shell-gate',
        payload: payload(actionDir, otherDir),
      }),
    ).toEqual({ decision: 'execute', repoRoot: realpathSync(repoRoot) })
  })

  it.each([
    {
      name: 'keeps global-origin hooks neutral for a project install',
      installScope: 'project' as const,
      origin: () => ({ scope: 'global' as const }),
    },
    {
      name: 'keeps a nonmatching project hook neutral',
      installScope: 'project' as const,
      origin: (_repoRoot: string, otherRepoRoot: string) => ({
        scope: 'project' as const,
        repoRoot: otherRepoRoot,
      }),
    },
  ])('$name', async ({ installScope, origin }) => {
    const repoRoot = await createTempDir('belay-cursor-project-route-')
    const otherRepoRoot = await createTempDir('belay-cursor-other-route-')
    const actionDir = path.join(repoRoot, 'packages', 'app')
    await mkdir(actionDir, { recursive: true })
    await installProjectHook(repoRoot, 'belay-shell-gate.mjs', installScope)

    expect(
      routeCursorHook({
        origin: origin(repoRoot, otherRepoRoot),
        kind: 'shell-gate',
        payload: { cwd: actionDir },
      }),
    ).toEqual({ decision: 'neutral' })
  })

  it('keeps a global hook neutral when the action repository has no Belay config', async () => {
    const repoRoot = await createTempDir('belay-cursor-unconfigured-route-')
    const actionDir = path.join(repoRoot, 'packages', 'app')
    await Promise.all([
      mkdir(path.join(repoRoot, '.git'), { recursive: true }),
      mkdir(actionDir, { recursive: true }),
    ])

    expect(
      routeCursorHook({
        origin: { scope: 'global' },
        kind: 'shell-gate',
        payload: { cwd: actionDir },
      }),
    ).toEqual({ decision: 'neutral' })
  })

  it.each([
    { kind: 'shell-gate' as const, hookFile: 'belay-shell-gate.mjs' },
    { kind: 'audit' as const, hookFile: 'belay-audit.mjs' },
  ])('fails closed with a diagnostic when a project $kind runtime is missing', async ({
    kind,
    hookFile,
  }) => {
    const repoRoot = await createTempDir('belay-cursor-incomplete-route-')
    const actionDir = path.join(repoRoot, 'packages', 'app')
    await mkdir(actionDir, { recursive: true })
    await installProjectHook(repoRoot, hookFile)
    await rm(path.join(repoRoot, '.cursor', 'belay', 'runtime', 'core.mjs'))

    expect(
      routeCursorHook({
        origin: { scope: 'project', repoRoot },
        kind,
        payload: { cwd: actionDir },
      }),
    ).toMatchObject({ decision: 'fail_closed', message: expect.stringMatching(/incomplete/i) })
  })

  it.each([
    { missingFile: ['.cursor', 'hooks', 'belay-shell-gate.mjs'] },
    { missingFile: ['.cursor', 'hooks', 'belay-runner'] },
  ])('fails closed when the current project shell-gate $missingFile is missing', async ({
    missingFile,
  }) => {
    const repoRoot = await createTempDir('belay-cursor-incomplete-route-')
    const actionDir = path.join(repoRoot, 'packages', 'app')
    await mkdir(actionDir, { recursive: true })
    await installProjectHook(repoRoot, 'belay-shell-gate.mjs')
    await rm(path.join(repoRoot, ...missingFile))

    expect(
      routeCursorHook({
        origin: { scope: 'project', repoRoot },
        kind: 'shell-gate',
        payload: { cwd: actionDir },
      }),
    ).toMatchObject({ decision: 'fail_closed', message: expect.stringMatching(/incomplete/i) })
  })

  it('fails closed when a global hook event has no usable action context', () => {
    expect(
      routeCursorHook({ origin: { scope: 'global' }, kind: 'before-submit', payload: { cwd: 1 } }),
    ).toMatchObject({ decision: 'fail_closed', message: expect.stringMatching(/workspace/i) })
  })

  it('fails closed rather than resolving a relative global-hook cwd from process cwd', () => {
    expect(
      routeCursorHook({
        origin: { scope: 'global' },
        kind: 'before-submit',
        payload: { cwd: '.' },
      }),
    ).toMatchObject({ decision: 'fail_closed', message: expect.stringMatching(/workspace/i) })
  })

  it('ignores a non-Shell tool_input working directory when selecting ownership', async () => {
    const repoRoot = await createTempDir('belay-cursor-project-route-')
    const otherRepoRoot = await createTempDir('belay-cursor-other-route-')
    const actionDir = path.join(repoRoot, 'packages', 'app')
    const otherDir = path.join(otherRepoRoot, 'packages', 'app')
    await Promise.all([mkdir(actionDir, { recursive: true }), mkdir(otherDir, { recursive: true })])
    await installProjectHook(repoRoot, 'belay-tool-gate.mjs')

    expect(
      routeCursorHook({
        origin: { scope: 'project', repoRoot },
        kind: 'tool-gate',
        payload: {
          tool_name: 'Write',
          tool_input: { working_directory: actionDir },
          cwd: otherDir,
        },
      }),
    ).toEqual({ decision: 'neutral' })
  })

  it('canonicalizes symlinked action and project-origin paths to one owner', async () => {
    const repoRoot = await createTempDir('belay-cursor-project-route-')
    const parent = await createTempDir('belay-cursor-link-parent-')
    const linkedRepoRoot = path.join(parent, 'linked-repo')
    const actionDir = path.join(repoRoot, 'packages', 'app')
    await mkdir(actionDir, { recursive: true })
    await installProjectHook(repoRoot, 'belay-shell-gate.mjs')
    await symlink(repoRoot, linkedRepoRoot)

    expect(
      routeCursorHook({
        origin: { scope: 'project', repoRoot: linkedRepoRoot },
        kind: 'shell-gate',
        payload: { cwd: path.join(linkedRepoRoot, 'packages', 'app') },
      }),
    ).toEqual({ decision: 'execute', repoRoot: realpathSync(repoRoot) })
  })
})
