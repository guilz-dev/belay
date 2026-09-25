import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { PassThrough } from 'node:stream'

import { afterEach, describe, expect, it } from 'vitest'

import { renderCursorProjectHookShim } from '../adapters/cursor/project-hook-shim.js'
import { trustRepoConfig } from '../core/repo-config-trust.js'
import { getManagedHookEntries } from '../defaults.js'

const tempDirs: string[] = []
const originalXdgConfigHome = process.env.XDG_CONFIG_HOME

async function createTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

async function writeAuditRepoConfig(
  repoRoot: string,
  mode: 'audit' | 'enforce',
  installScope: 'project' | 'global' = 'project',
  trusted = true,
): Promise<void> {
  const rawConfig = { installScope, mode }
  await writeFile(
    path.join(repoRoot, '.cursor', 'belay.config.json'),
    `${JSON.stringify(rawConfig)}\n`,
  )
  if (trusted) {
    await trustRepoConfig(repoRoot, 'cursor', rawConfig)
  }
}

async function installProjectHook(repoRoot: string, mode: 'audit' | 'enforce'): Promise<void> {
  const xdgConfigHome = await mkdtemp(path.join(os.tmpdir(), 'belay-cursor-dispatch-xdg-'))
  tempDirs.push(xdgConfigHome)
  process.env.XDG_CONFIG_HOME = xdgConfigHome
  await mkdir(path.join(repoRoot, '.git'), { recursive: true })
  await mkdir(path.join(repoRoot, '.cursor', 'hooks'), { recursive: true })
  await mkdir(path.join(repoRoot, '.cursor', 'belay', 'runtime'), { recursive: true })
  await writeAuditRepoConfig(repoRoot, mode, 'project')
  const hooksDir = path.join(repoRoot, '.cursor', 'hooks')
  const groupedHooks: Record<
    string,
    Array<{ command: string; matcher?: string; failClosed: false }>
  > = {}
  for (const { event, definition } of getManagedHookEntries(process.platform, hooksDir, repoRoot)) {
    const eventHooks = groupedHooks[event] ?? []
    groupedHooks[event] = eventHooks
    eventHooks.push({
      command: definition.command,
      ...(definition.matcher === undefined ? {} : { matcher: definition.matcher }),
      failClosed: false,
    })
  }
  await writeFile(
    path.join(repoRoot, '.cursor', 'hooks.json'),
    `${JSON.stringify({ version: 1, hooks: groupedHooks }, null, 2)}\n`,
  )
  await writeFile(
    path.join(hooksDir, 'belay-shell-gate.mjs'),
    renderCursorProjectHookShim('shell-gate', '"beforeShellExecution"'),
  )
  await writeFile(path.join(hooksDir, 'belay-runner'), '')
  await chmod(path.join(hooksDir, 'belay-runner'), 0o755)
  await writeFile(path.join(repoRoot, '.cursor', 'belay', 'runtime', 'core.mjs'), '')
  await writeFile(path.join(repoRoot, '.cursor', 'belay', 'runtime', 'dispatcher.mjs'), '')
}

async function dispatchHook(
  params: {
    origin: { scope: 'project'; repoRoot: string } | { scope: 'global' }
    kind: 'shell-gate' | 'tool-gate'
    eventName: string
  },
  payload: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const { dispatchCursorHookResponse } = await import('../adapters/cursor/hook-dispatch-entry.js')
  const stdin = new PassThrough()
  const originalStdin = process.stdin
  Object.defineProperty(process, 'stdin', { configurable: true, value: stdin })

  try {
    const responsePromise = dispatchCursorHookResponse(params)
    stdin.end(JSON.stringify(payload))
    return (await responsePromise) as Record<string, unknown>
  } finally {
    Object.defineProperty(process, 'stdin', { configurable: true, value: originalStdin })
  }
}

afterEach(async () => {
  if (originalXdgConfigHome === undefined) {
    delete process.env.XDG_CONFIG_HOME
  } else {
    process.env.XDG_CONFIG_HOME = originalXdgConfigHome
  }
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

describe('dispatchCursorHookResponse routing fail-open in audit mode', () => {
  it('allows shell-gate when route fails closed and project mode is audit', async () => {
    const repoRoot = await createTempDir('belay-cursor-dispatch-audit-')
    await installProjectHook(repoRoot, 'audit')
    const missingCwd = path.join(repoRoot, 'does-not-exist')

    const response = await dispatchHook(
      {
        origin: { scope: 'project', repoRoot },
        kind: 'shell-gate',
        eventName: 'beforeShellExecution',
      },
      {
        command: 'git status',
        cwd: missingCwd,
      },
    )

    expect(response).toEqual({ permission: 'allow' })
  })

  it('keeps deny response for the same routing failure in enforce mode', async () => {
    const repoRoot = await createTempDir('belay-cursor-dispatch-enforce-')
    await installProjectHook(repoRoot, 'enforce')
    const missingCwd = path.join(repoRoot, 'does-not-exist')

    const response = await dispatchHook(
      {
        origin: { scope: 'project', repoRoot },
        kind: 'shell-gate',
        eventName: 'beforeShellExecution',
      },
      {
        command: 'git status',
        cwd: missingCwd,
      },
    )

    expect(response).toMatchObject({
      permission: 'deny',
      user_message: 'belay could not determine the workspace.',
    })
  })

  it('allows global tool-gate routing failures when workspace_roots indicate audit mode', async () => {
    const repoRoot = await createTempDir('belay-cursor-dispatch-global-audit-')
    await mkdir(path.join(repoRoot, '.git'), { recursive: true })
    await mkdir(path.join(repoRoot, '.cursor'), { recursive: true })
    await writeAuditRepoConfig(repoRoot, 'audit', 'global')
    const missingCwd = path.join(repoRoot, 'does-not-exist')

    const response = await dispatchHook(
      {
        origin: { scope: 'global' },
        kind: 'tool-gate',
        eventName: 'preToolUse',
      },
      {
        tool_name: 'Grep',
        tool_input: { pattern: 'foo' },
        cwd: missingCwd,
        workspace_roots: [repoRoot],
      },
    )

    expect(response).toEqual({ permission: 'allow' })
  })

  it('keeps deny for global tool-gate routing failures when workspace policy is enforce', async () => {
    const repoRoot = await createTempDir('belay-cursor-dispatch-global-enforce-')
    await mkdir(path.join(repoRoot, '.git'), { recursive: true })
    await mkdir(path.join(repoRoot, '.cursor'), { recursive: true })
    await writeAuditRepoConfig(repoRoot, 'enforce', 'global')
    const missingCwd = path.join(repoRoot, 'does-not-exist')

    const response = await dispatchHook(
      {
        origin: { scope: 'global' },
        kind: 'tool-gate',
        eventName: 'preToolUse',
      },
      {
        tool_name: 'Grep',
        tool_input: { pattern: 'foo' },
        cwd: missingCwd,
        workspace_roots: [repoRoot],
      },
    )

    expect(response).toMatchObject({
      permission: 'deny',
      user_message: 'belay could not determine the workspace.',
    })
  })

  it('does not let an untrusted audit config loosen a global routing failure', async () => {
    const repoRoot = await createTempDir('belay-cursor-dispatch-untrusted-audit-')
    const xdgConfigHome = await createTempDir('belay-cursor-dispatch-untrusted-xdg-')
    process.env.XDG_CONFIG_HOME = xdgConfigHome
    await mkdir(path.join(repoRoot, '.git'), { recursive: true })
    await mkdir(path.join(repoRoot, '.cursor'), { recursive: true })
    await writeAuditRepoConfig(repoRoot, 'audit', 'global', false)

    const response = await dispatchHook(
      {
        origin: { scope: 'global' },
        kind: 'tool-gate',
        eventName: 'preToolUse',
      },
      {
        tool_name: 'Grep',
        tool_input: { pattern: 'foo' },
        workspace_roots: [repoRoot],
      },
    )

    expect(response).toMatchObject({ permission: 'deny' })
  })
})
