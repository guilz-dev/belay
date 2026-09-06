import { realpathSync } from 'node:fs'
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { routeCursorHook } from '../adapters/cursor/hook-router.js'
import { trustRepoConfig } from '../core/repo-config-trust.js'
import { getManagedHookEntries } from '../defaults.js'

const tempDirs: string[] = []
const originalXdgConfigHome = process.env.XDG_CONFIG_HOME

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
  const xdgConfigHome = await mkdtemp(path.join(os.tmpdir(), 'belay-cursor-router-xdg-'))
  tempDirs.push(xdgConfigHome)
  process.env.XDG_CONFIG_HOME = xdgConfigHome
  await mkdir(path.join(repoRoot, '.git'), { recursive: true })
  await mkdir(path.join(repoRoot, '.cursor', 'hooks'), { recursive: true })
  await mkdir(path.join(repoRoot, '.cursor', 'belay', 'runtime'), { recursive: true })
  const rawConfig = { installScope }
  await writeFile(
    path.join(repoRoot, '.cursor', 'belay.config.json'),
    `${JSON.stringify(rawConfig)}\n`,
  )
  await trustRepoConfig(repoRoot, 'cursor', rawConfig)
  const canonicalRepoRoot = realpathSync(repoRoot)
  const hooksDir = path.join(repoRoot, '.cursor', 'hooks')
  const groupedHooks: Record<
    string,
    Array<{ command: string; matcher?: string; failClosed: true }>
  > = {}
  for (const { event, definition } of getManagedHookEntries(process.platform, hooksDir, repoRoot)) {
    const eventHooks = groupedHooks[event] ?? []
    groupedHooks[event] = eventHooks
    eventHooks.push({
      command: definition.command,
      ...(definition.matcher === undefined ? {} : { matcher: definition.matcher }),
      failClosed: true,
    })
  }
  await writeFile(
    path.join(repoRoot, '.cursor', 'hooks.json'),
    `${JSON.stringify({ version: 1, hooks: groupedHooks }, null, 2)}\n`,
  )
  await writeFile(
    path.join(hooksDir, hookFile),
    `import { dispatchCursorHook } from '../belay/runtime/dispatcher.mjs'\nvoid { origin: ${JSON.stringify({ scope: 'project', repoRoot: canonicalRepoRoot })} }\n`,
  )
  await writeFile(path.join(repoRoot, '.cursor', 'hooks', 'belay-runner'), '')
  await chmod(path.join(repoRoot, '.cursor', 'hooks', 'belay-runner'), 0o755)
  await writeFile(path.join(repoRoot, '.cursor', 'hooks', 'belay-runner.ps1'), '')
  await writeFile(path.join(repoRoot, '.cursor', 'belay', 'runtime', 'core.mjs'), '')
  await writeFile(path.join(repoRoot, '.cursor', 'belay', 'runtime', 'dispatcher.mjs'), '')
}

describe('routeCursorHook', () => {
  afterEach(async () => {
    if (originalXdgConfigHome === undefined) {
      delete process.env.XDG_CONFIG_HOME
    } else {
      process.env.XDG_CONFIG_HOME = originalXdgConfigHome
    }
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

  it('keeps every source neutral when the repository config is missing', async () => {
    const repoRoot = await createTempDir('belay-cursor-missing-config-route-')
    const actionDir = path.join(repoRoot, 'packages', 'app')
    await Promise.all([
      mkdir(path.join(repoRoot, '.git'), { recursive: true }),
      mkdir(actionDir, { recursive: true }),
    ])

    for (const origin of [{ scope: 'global' as const }, { scope: 'project' as const, repoRoot }]) {
      expect(
        routeCursorHook({
          origin,
          kind: 'shell-gate',
          payload: { cwd: actionDir },
        }),
      ).toEqual({ decision: 'neutral' })
    }
  })

  it('normalizes an omitted installScope to the project owner', async () => {
    const repoRoot = await createTempDir('belay-cursor-omitted-scope-route-')
    const actionDir = path.join(repoRoot, 'packages', 'app')
    await mkdir(actionDir, { recursive: true })
    await installProjectHook(repoRoot, 'belay-shell-gate.mjs')
    await writeFile(path.join(repoRoot, '.cursor', 'belay.config.json'), '{}\n')

    expect(
      routeCursorHook({
        origin: { scope: 'project', repoRoot },
        kind: 'shell-gate',
        payload: { cwd: actionDir },
      }),
    ).toEqual({ decision: 'execute', repoRoot: realpathSync(repoRoot) })
    expect(
      routeCursorHook({
        origin: { scope: 'global' },
        kind: 'shell-gate',
        payload: { cwd: actionDir },
      }),
    ).toEqual({ decision: 'neutral' })
  })

  it('routes an untrusted global installScope through the global owner when no project installation exists', async () => {
    const repoRoot = await createTempDir('belay-cursor-untrusted-global-only-route-')
    const actionDir = path.join(repoRoot, 'packages', 'app')
    await mkdir(actionDir, { recursive: true })
    await mkdir(path.join(repoRoot, '.cursor'), { recursive: true })
    await writeFile(
      path.join(repoRoot, '.cursor', 'belay.config.json'),
      `${JSON.stringify({ installScope: 'global' })}\n`,
    )

    expect(
      routeCursorHook({
        origin: { scope: 'global' },
        kind: 'shell-gate',
        payload: { cwd: actionDir },
      }),
    ).toEqual({ decision: 'execute', repoRoot: realpathSync(repoRoot) })
    expect(
      routeCursorHook({
        origin: { scope: 'project', repoRoot },
        kind: 'shell-gate',
        payload: { cwd: actionDir },
      }),
    ).toEqual({ decision: 'neutral' })
  })

  it('keeps an untrusted global installScope on the project path when a project runtime exists', async () => {
    const repoRoot = await createTempDir('belay-cursor-untrusted-global-project-runtime-route-')
    const actionDir = path.join(repoRoot, 'packages', 'app')
    const hooksDir = path.join(repoRoot, '.cursor', 'hooks')
    const runtimeDir = path.join(repoRoot, '.cursor', 'belay', 'runtime')
    await mkdir(actionDir, { recursive: true })
    await mkdir(hooksDir, { recursive: true })
    await mkdir(runtimeDir, { recursive: true })
    await writeFile(
      path.join(repoRoot, '.cursor', 'belay.config.json'),
      `${JSON.stringify({ installScope: 'global' })}\n`,
    )
    const runnerPath = path.join(
      hooksDir,
      process.platform === 'win32' ? 'belay-runner.ps1' : 'belay-runner',
    )
    await writeFile(runnerPath, '')
    if (process.platform !== 'win32') {
      await chmod(runnerPath, 0o755)
    }
    await writeFile(path.join(runtimeDir, 'dispatcher.mjs'), '')

    expect(
      routeCursorHook({
        origin: { scope: 'global' },
        kind: 'shell-gate',
        payload: { cwd: actionDir },
      }),
    ).toMatchObject({
      decision: 'fail_closed',
      message: expect.stringMatching(/project hook owner.*unavailable/i),
    })
    expect(
      routeCursorHook({
        origin: { scope: 'project', repoRoot },
        kind: 'shell-gate',
        payload: { cwd: actionDir },
      }),
    ).toEqual({
      decision: 'fail_closed',
      message: 'belay project hook installation is incomplete.',
    })
  })

  it('does not let an untrusted global installScope disable the project owner', async () => {
    const repoRoot = await createTempDir('belay-cursor-untrusted-scope-route-')
    const actionDir = path.join(repoRoot, 'packages', 'app')
    await mkdir(actionDir, { recursive: true })
    await installProjectHook(repoRoot, 'belay-shell-gate.mjs')
    await writeFile(
      path.join(repoRoot, '.cursor', 'belay.config.json'),
      `${JSON.stringify({ installScope: 'global' })}\n`,
    )

    expect(
      routeCursorHook({
        origin: { scope: 'project', repoRoot },
        kind: 'shell-gate',
        payload: { cwd: actionDir },
      }),
    ).toEqual({ decision: 'execute', repoRoot: realpathSync(repoRoot) })
    expect(
      routeCursorHook({
        origin: { scope: 'global' },
        kind: 'shell-gate',
        payload: { cwd: actionDir },
      }),
    ).toEqual({ decision: 'neutral' })
  })

  it.each([
    { name: 'malformed', config: '{not-json\n' },
    { name: 'structurally invalid', config: '[]\n' },
    { name: 'invalid installScope', config: '{"installScope":"managed"}\n' },
  ])('routes a present $name config through the project owner', async ({ config }) => {
    const repoRoot = await createTempDir('belay-cursor-broken-config-route-')
    const actionDir = path.join(repoRoot, 'packages', 'app')
    await mkdir(actionDir, { recursive: true })
    await installProjectHook(repoRoot, 'belay-shell-gate.mjs')
    await writeFile(path.join(repoRoot, '.cursor', 'belay.config.json'), config)

    expect(
      routeCursorHook({
        origin: { scope: 'project', repoRoot },
        kind: 'shell-gate',
        payload: { cwd: actionDir },
      }),
    ).toEqual({ decision: 'execute', repoRoot: realpathSync(repoRoot) })
    expect(
      routeCursorHook({
        origin: { scope: 'global' },
        kind: 'shell-gate',
        payload: { cwd: actionDir },
      }),
    ).toEqual({ decision: 'neutral' })
  })

  it('routes an unreadable config path through the project owner', async () => {
    const repoRoot = await createTempDir('belay-cursor-unreadable-config-route-')
    const actionDir = path.join(repoRoot, 'packages', 'app')
    const configPath = path.join(repoRoot, '.cursor', 'belay.config.json')
    await mkdir(actionDir, { recursive: true })
    await installProjectHook(repoRoot, 'belay-shell-gate.mjs')
    await rm(configPath)
    await mkdir(configPath)

    expect(
      routeCursorHook({
        origin: { scope: 'project', repoRoot },
        kind: 'shell-gate',
        payload: { cwd: actionDir },
      }),
    ).toEqual({ decision: 'execute', repoRoot: realpathSync(repoRoot) })
    expect(
      routeCursorHook({
        origin: { scope: 'global' },
        kind: 'shell-gate',
        payload: { cwd: actionDir },
      }),
    ).toEqual({ decision: 'neutral' })
  })

  it.each([
    {
      name: 'managed hook entry',
      removeOwnerPart: async (repoRoot: string) => {
        const hooksPath = path.join(repoRoot, '.cursor', 'hooks.json')
        const hooks = JSON.parse(await readFile(hooksPath, 'utf8')) as {
          hooks: Record<string, unknown>
        }
        delete hooks.hooks.beforeShellExecution
        await writeFile(hooksPath, `${JSON.stringify(hooks)}\n`)
      },
    },
    {
      name: 'runner',
      removeOwnerPart: (repoRoot: string) =>
        rm(
          path.join(
            repoRoot,
            '.cursor',
            'hooks',
            process.platform === 'win32' ? 'belay-runner.ps1' : 'belay-runner',
          ),
        ),
    },
    {
      name: 'executable runner',
      removeOwnerPart: (repoRoot: string) =>
        process.platform === 'win32'
          ? rm(path.join(repoRoot, '.cursor', 'hooks', 'belay-runner.ps1'))
          : chmod(path.join(repoRoot, '.cursor', 'hooks', 'belay-runner'), 0o644),
    },
    {
      name: 'shim',
      removeOwnerPart: (repoRoot: string) =>
        rm(path.join(repoRoot, '.cursor', 'hooks', 'belay-shell-gate.mjs')),
    },
    {
      name: 'dispatcher',
      removeOwnerPart: (repoRoot: string) =>
        rm(path.join(repoRoot, '.cursor', 'belay', 'runtime', 'dispatcher.mjs')),
    },
  ])('uses the global origin as a sentinel when the project $name is missing', async ({
    removeOwnerPart,
  }) => {
    const repoRoot = await createTempDir('belay-cursor-project-sentinel-route-')
    const actionDir = path.join(repoRoot, 'packages', 'app')
    await mkdir(actionDir, { recursive: true })
    await installProjectHook(repoRoot, 'belay-shell-gate.mjs')
    await removeOwnerPart(repoRoot)

    expect(
      routeCursorHook({
        origin: { scope: 'global' },
        kind: 'shell-gate',
        payload: { cwd: actionDir },
      }),
    ).toMatchObject({
      decision: 'fail_closed',
      message: expect.stringMatching(/project hook owner.*unavailable/i),
    })
  })

  it('keeps a nonmatching project origin neutral when the matching project owner is missing', async () => {
    const repoRoot = await createTempDir('belay-cursor-project-sentinel-route-')
    const otherRepoRoot = await createTempDir('belay-cursor-other-route-')
    const actionDir = path.join(repoRoot, 'packages', 'app')
    await mkdir(actionDir, { recursive: true })
    await installProjectHook(repoRoot, 'belay-shell-gate.mjs')
    await rm(path.join(repoRoot, '.cursor', 'belay', 'runtime', 'dispatcher.mjs'))

    expect(
      routeCursorHook({
        origin: { scope: 'project', repoRoot: otherRepoRoot },
        kind: 'shell-gate',
        payload: { cwd: actionDir },
      }),
    ).toEqual({ decision: 'neutral' })
  })

  it('keeps the global origin neutral when the callable project owner is missing only core', async () => {
    const repoRoot = await createTempDir('belay-cursor-project-sentinel-route-')
    const actionDir = path.join(repoRoot, 'packages', 'app')
    await mkdir(actionDir, { recursive: true })
    await installProjectHook(repoRoot, 'belay-shell-gate.mjs')
    await rm(path.join(repoRoot, '.cursor', 'belay', 'runtime', 'core.mjs'))

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
    { missingFile: ['.cursor', 'belay', 'runtime', 'dispatcher.mjs'] },
    { missingFile: ['.cursor', 'hooks.json'] },
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
