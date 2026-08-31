import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { claudeAdapter } from '../adapters/claude/adapter.js'
import { getClaudeManagedHookEntries } from '../adapters/claude/hooks.js'
import { codexAdapter } from '../adapters/codex/adapter.js'
import { getCodexManagedHookEntries } from '../adapters/codex/hooks.js'
import { cursorLayout } from '../adapters/layouts/cursor.js'
import { resolveScopedPaths } from '../adapters/layouts/scope.js'
import { doctorProject } from '../commands/doctor.js'
import { metricsProject } from '../commands/metrics.js'
import { loadConfigFile, pendingApprovalsPath } from '../config-io.js'
import { runtimeIntegrityFiles } from '../core/integrity.js'
import { getManagedHookEntries } from '../defaults.js'
import { initProject, uninstallProject, upgradeProject } from '../installer.js'
import { PACKAGE_VERSION } from '../version.js'

const tempDirs: string[] = []
const originalHome = process.env.HOME

async function createTempRepo() {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'agent-belay-scope-'))
  tempDirs.push(tempDir)
  return tempDir
}

async function createTempHome() {
  const homeDir = await mkdtemp(path.join(os.tmpdir(), 'agent-belay-home-'))
  tempDirs.push(homeDir)
  process.env.HOME = homeDir
  return homeDir
}

describe('installer scope (T29)', () => {
  afterEach(async () => {
    vi.restoreAllMocks()
    process.env.HOME = originalHome
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
  })

  it('project scope (default) writes hooks and config under the repo', async () => {
    const repoRoot = await createTempRepo()
    await initProject({ targetDir: repoRoot, withSkill: true })

    expect(existsSync(path.join(repoRoot, '.cursor', 'hooks', 'belay-runner'))).toBe(true)
    expect(existsSync(path.join(repoRoot, '.cursor', 'hooks.json'))).toBe(true)
    expect(existsSync(path.join(repoRoot, '.cursor', 'belay.config.json'))).toBe(true)
    expect(existsSync(path.join(repoRoot, '.cursor', 'skills', 'belay', 'SKILL.md'))).toBe(true)

    const config = await loadConfigFile(repoRoot, 'cursor')
    expect(config.installScope).toBe('project')
  })

  it('global scope writes hooks and skill to HOME while config stays in repo', async () => {
    const homeDir = await createTempHome()
    const repoRoot = await createTempRepo()
    await initProject({ targetDir: repoRoot, scope: 'global', withSkill: true })

    const globalCursor = path.join(homeDir, '.cursor')
    expect(existsSync(path.join(globalCursor, 'hooks', 'belay-runner'))).toBe(true)
    expect(existsSync(path.join(globalCursor, 'hooks.json'))).toBe(true)
    expect(existsSync(path.join(globalCursor, 'skills', 'belay', 'SKILL.md'))).toBe(true)
    expect(existsSync(path.join(globalCursor, 'belay', 'runtime', 'core.mjs'))).toBe(true)

    expect(existsSync(path.join(repoRoot, '.cursor', 'hooks', 'belay-runner'))).toBe(false)
    expect(existsSync(path.join(repoRoot, '.cursor', 'belay.config.json'))).toBe(true)
    const config = await loadConfigFile(repoRoot, 'cursor')
    expect(config.installScope).toBe('global')
    expect(existsSync(pendingApprovalsPath(repoRoot, config))).toBe(true)
    const metrics = await metricsProject({ targetDir: repoRoot })
    expect(metrics.currentCohort.identity?.runtimeBuildStamp).toMatch(
      new RegExp(`^${PACKAGE_VERSION.replace(/\./g, '\\.')}@`),
    )
  })

  it('upgrade without --scope reuses persisted global scope', async () => {
    const homeDir = await createTempHome()
    const repoRoot = await createTempRepo()
    await initProject({ targetDir: repoRoot, scope: 'global' })
    await upgradeProject({ targetDir: repoRoot })

    expect(existsSync(path.join(homeDir, '.cursor', 'hooks', 'belay-tool-gate.mjs'))).toBe(true)
    expect(existsSync(path.join(repoRoot, '.cursor', 'hooks', 'belay-tool-gate.mjs'))).toBe(false)
    const config = await loadConfigFile(repoRoot, 'cursor')
    expect(config.installScope).toBe('global')
  })

  it('project upgrade refreshes an existing managed global router without changing project scope', async () => {
    const homeDir = await createTempHome()
    const repoRoot = await createTempRepo()
    await initProject({ targetDir: repoRoot, scope: 'global' })
    await initProject({ targetDir: repoRoot, scope: 'project' })

    const globalRuntimeDir = path.join(homeDir, '.cursor', 'belay', 'runtime')
    const globalHooksDir = path.join(homeDir, '.cursor', 'hooks')
    await writeFile(path.join(globalRuntimeDir, 'dispatcher.mjs'), '// old dispatcher\n')
    await writeFile(path.join(globalRuntimeDir, 'core.mjs'), '// old core\n')
    await writeFile(
      path.join(globalHooksDir, 'belay-shell-gate.mjs'),
      "import { runShellGateHook } from '../belay/runtime/core.mjs'\nawait runShellGateHook()\n",
    )

    await upgradeProject({ targetDir: repoRoot })

    const config = await loadConfigFile(repoRoot, 'cursor')
    expect(config.installScope).toBe('project')
    await expect(readFile(path.join(globalRuntimeDir, 'dispatcher.mjs'), 'utf8')).resolves.toBe(
      await readFile(path.join(repoRoot, '.cursor', 'belay', 'runtime', 'dispatcher.mjs'), 'utf8'),
    )
    await expect(readFile(path.join(globalRuntimeDir, 'core.mjs'), 'utf8')).resolves.toBe(
      await readFile(path.join(repoRoot, '.cursor', 'belay', 'runtime', 'core.mjs'), 'utf8'),
    )
    const globalShim = await readFile(path.join(globalHooksDir, 'belay-shell-gate.mjs'), 'utf8')
    expect(globalShim).toContain('origin: {"scope":"global"}')
    expect(globalShim).toContain("from '../belay/runtime/dispatcher.mjs'")
  })

  it('global selection removes only stale exact project hooks and artifacts for the current repo', async () => {
    await createTempHome()
    const repoRoot = await createTempRepo()
    const siblingRoot = await createTempRepo()
    await initProject({ targetDir: repoRoot })
    await initProject({ targetDir: siblingRoot })

    const projectHooksPath = path.join(repoRoot, '.cursor', 'hooks.json')
    const projectHooks = JSON.parse(await readFile(projectHooksPath, 'utf8')) as {
      version: number
      hooks: Record<string, Array<{ command: string; matcher?: string }>>
    }
    const unknownEntry = { command: './.cursor/hooks/belay-runner belay-shell-gate --unknown' }
    projectHooks.hooks.beforeShellExecution = [
      unknownEntry,
      ...(projectHooks.hooks.beforeShellExecution ?? []),
    ]
    await writeFile(projectHooksPath, `${JSON.stringify(projectHooks, null, 2)}\n`)

    await upgradeProject({ targetDir: repoRoot, scope: 'global' })

    const cleaned = JSON.parse(await readFile(projectHooksPath, 'utf8')) as {
      hooks: Record<string, Array<{ command: string }>>
    }
    expect(cleaned.hooks.beforeShellExecution).toEqual([unknownEntry])
    expect(
      Object.values(cleaned.hooks)
        .flat()
        .filter((entry) => entry.command !== unknownEntry.command),
    ).toHaveLength(0)
    expect(existsSync(path.join(repoRoot, '.cursor', 'hooks', 'belay-runner'))).toBe(false)
    expect(existsSync(path.join(repoRoot, '.cursor', 'belay', 'runtime', 'dispatcher.mjs'))).toBe(
      false,
    )
    expect(existsSync(path.join(siblingRoot, '.cursor', 'hooks', 'belay-runner'))).toBe(true)
    expect(
      existsSync(path.join(siblingRoot, '.cursor', 'belay', 'runtime', 'dispatcher.mjs')),
    ).toBe(true)
  })

  it('global selection preserves project artifacts when no exact managed hook proves ownership', async () => {
    await createTempHome()
    const repoRoot = await createTempRepo()
    const projectHooksDir = path.join(repoRoot, '.cursor', 'hooks')
    const projectRuntimeDir = path.join(repoRoot, '.cursor', 'belay', 'runtime')
    await mkdir(projectHooksDir, { recursive: true })
    await mkdir(projectRuntimeDir, { recursive: true })
    const unknownHooks = {
      version: 1,
      hooks: {
        beforeShellExecution: [
          { command: './.cursor/hooks/belay-runner belay-shell-gate --unknown' },
        ],
      },
    }
    await writeFile(
      path.join(repoRoot, '.cursor', 'hooks.json'),
      `${JSON.stringify(unknownHooks, null, 2)}\n`,
    )
    await writeFile(path.join(projectHooksDir, 'belay-runner'), 'unknown runner\n')
    await writeFile(path.join(projectRuntimeDir, 'dispatcher.mjs'), '// unknown dispatcher\n')

    await initProject({ targetDir: repoRoot, scope: 'global' })

    expect(
      JSON.parse(await readFile(path.join(repoRoot, '.cursor', 'hooks.json'), 'utf8')),
    ).toEqual(unknownHooks)
    await expect(readFile(path.join(projectHooksDir, 'belay-runner'), 'utf8')).resolves.toBe(
      'unknown runner\n',
    )
    await expect(readFile(path.join(projectRuntimeDir, 'dispatcher.mjs'), 'utf8')).resolves.toBe(
      '// unknown dispatcher\n',
    )
  })

  it('keeps the runtime artifact cohort stable across a same-bundle upgrade', async () => {
    const repoRoot = await createTempRepo()
    await initProject({ targetDir: repoRoot })
    const before = (await metricsProject({ targetDir: repoRoot })).currentCohort.identity

    await upgradeProject({ targetDir: repoRoot })
    const after = (await metricsProject({ targetDir: repoRoot })).currentCohort.identity

    expect(before?.runtimeArtifactHash).toMatch(/^[a-f0-9]{64}$/)
    expect(after?.runtimeArtifactHash).toBe(before?.runtimeArtifactHash)
    expect(after?.runtimeBuildStamp).toBe(before?.runtimeBuildStamp)
  })

  it('global scope uses absolute runner paths in hooks.json', async () => {
    const homeDir = await createTempHome()
    const repoRoot = await createTempRepo()
    await initProject({ targetDir: repoRoot, scope: 'global' })

    const hooks = JSON.parse(
      await readFile(path.join(homeDir, '.cursor', 'hooks.json'), 'utf8'),
    ) as { hooks: { beforeShellExecution: Array<{ command: string }> } }
    const shellCommand = hooks.hooks.beforeShellExecution[0]?.command ?? ''
    expect(shellCommand).toContain(path.join(homeDir, '.cursor', 'hooks', 'belay-runner'))
    expect(shellCommand).not.toMatch(/^\.\//)
  })

  it('integrity manifest lists project files only for global scope', async () => {
    const homeDir = await createTempHome()
    const repoRoot = await createTempRepo()
    await initProject({ targetDir: repoRoot, scope: 'global' })

    const paths = resolveScopedPaths(cursorLayout, 'global', repoRoot)
    const files = runtimeIntegrityFiles(cursorLayout, paths)
    expect(files).toEqual([paths.configPath])
    expect(files.every((filePath) => filePath.startsWith(repoRoot))).toBe(true)

    const manifestPath = path.join(repoRoot, '.cursor', 'belay', 'integrity-manifest.json')
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as {
      files: Record<string, string>
    }
    expect(Object.keys(manifest.files)).toEqual(['.cursor/belay.config.json'])
    expect(existsSync(path.join(homeDir, '.cursor', 'hooks', 'belay-tool-gate.mjs'))).toBe(true)
  })

  it('doctor passes after global install', async () => {
    const homeDir = await createTempHome()
    const repoRoot = await createTempRepo()
    await initProject({
      targetDir: repoRoot,
      scope: 'global',
      withSkill: true,
      judgeProviderId: 'ollama',
    })

    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ models: [{ name: 'gemma4:e2b' }] }), { status: 200 }),
    )

    const report = await doctorProject({ targetDir: repoRoot })
    expect(report.ok).toBe(true)
    expect(report.notes.some((note) => note.includes('Install scope: global'))).toBe(true)
    expect(report.hooksPath).toBe(path.join(homeDir, '.cursor', 'hooks.json'))
  })

  it('managed scope is rejected', async () => {
    const repoRoot = await createTempRepo()
    await expect(
      initProject({ targetDir: repoRoot, scope: 'managed' as 'project' }),
    ).rejects.toThrow(/managed install scope is not implemented/)
  })

  it('project scope uses an absolute Cursor runner path while Claude and Codex stay relative', async () => {
    const repoRoot = await createTempRepo()
    await initProject({ targetDir: repoRoot })

    const hooksDir = cursorLayout.hooksDir(repoRoot)
    const managed = getManagedHookEntries(process.platform, hooksDir, repoRoot)
    const shellHook = managed.find((entry) => entry.event === 'beforeShellExecution')?.definition
    expect(shellHook?.command).toBe(
      `${path.join(hooksDir, process.platform === 'win32' ? 'belay-runner.cmd' : 'belay-runner')} belay-shell-gate`,
    )

    const claudeShellHook = getClaudeManagedHookEntries(
      process.platform,
      path.join(repoRoot, '.claude', 'hooks'),
      repoRoot,
    ).find((entry) => entry.event === 'PreToolUse')?.definition
    const codexShellHook = getCodexManagedHookEntries(
      process.platform,
      path.join(repoRoot, '.codex', 'hooks'),
      repoRoot,
    ).find((entry) => entry.event === 'PreToolUse')?.definition
    expect(claudeShellHook?.command).toMatch(/^\.\//)
    expect(codexShellHook?.command).toMatch(/^\.\//)
  })

  it('claude global scope writes skill under HOME', async () => {
    const homeDir = await createTempHome()
    const repoRoot = await createTempRepo()
    await mkdir(path.join(repoRoot, '.git'))
    await claudeAdapter.install(repoRoot, { scope: 'global', withSkill: true })

    expect(existsSync(path.join(homeDir, '.claude', 'skills', 'belay', 'SKILL.md'))).toBe(true)
    expect(existsSync(path.join(homeDir, '.claude', 'hooks', 'belay-runner'))).toBe(true)
    const config = await loadConfigFile(repoRoot, 'claude')
    expect(config.installScope).toBe('global')
  })

  it('codex global scope writes hooks under HOME', async () => {
    const homeDir = await createTempHome()
    const repoRoot = await createTempRepo()
    await mkdir(path.join(repoRoot, '.git'))
    await codexAdapter.install(repoRoot, { scope: 'global', withSkill: true })

    expect(existsSync(path.join(homeDir, '.codex', 'hooks', 'belay-runner'))).toBe(true)
    expect(existsSync(path.join(homeDir, '.codex', 'skills', 'belay', 'SKILL.md'))).toBe(true)
    const config = await loadConfigFile(repoRoot, 'codex')
    expect(config.installScope).toBe('global')
  })

  it('uninstall --scope global removes hooks.json entries and hook artifacts', async () => {
    const homeDir = await createTempHome()
    const repoRoot = await createTempRepo()
    await initProject({ targetDir: repoRoot, scope: 'global', withSkill: true })

    const hooksPath = path.join(homeDir, '.cursor', 'hooks.json')
    const hooksBefore = JSON.parse(await readFile(hooksPath, 'utf8')) as {
      hooks: Record<string, unknown[]>
    }
    expect(hooksBefore.hooks.beforeShellExecution?.length ?? 0).toBeGreaterThan(0)
    expect(existsSync(path.join(homeDir, '.cursor', 'hooks', 'belay-runner'))).toBe(true)
    expect(existsSync(path.join(homeDir, '.cursor', 'belay', 'runtime', 'dispatcher.mjs'))).toBe(
      true,
    )

    const result = await uninstallProject({ targetDir: repoRoot, scope: 'global' })
    expect(result.scope).toBe('global')

    const hooksAfter = JSON.parse(await readFile(hooksPath, 'utf8')) as {
      hooks: Record<string, unknown[]>
    }
    const belayEntries = Object.values(hooksAfter.hooks)
      .flat()
      .filter((entry) => {
        const command =
          entry && typeof entry === 'object' && 'command' in entry
            ? String((entry as { command?: string }).command ?? '')
            : ''
        return command.includes('belay-runner')
      })
    expect(belayEntries).toHaveLength(0)
    expect(existsSync(path.join(homeDir, '.cursor', 'hooks', 'belay-runner'))).toBe(false)
    expect(existsSync(path.join(homeDir, '.cursor', 'belay', 'runtime', 'core.mjs'))).toBe(false)
    expect(existsSync(path.join(homeDir, '.cursor', 'belay', 'runtime', 'dispatcher.mjs'))).toBe(
      false,
    )
    expect(existsSync(path.join(homeDir, '.cursor', 'skills', 'belay', 'SKILL.md'))).toBe(false)
  })
})
