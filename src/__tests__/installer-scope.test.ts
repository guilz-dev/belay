import { exec as execCallback, execFile as execFileCallback, spawnSync } from 'node:child_process'
import { existsSync, realpathSync } from 'node:fs'
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { claudeAdapter } from '../adapters/claude/adapter.js'
import { getClaudeManagedHookEntries } from '../adapters/claude/hooks.js'
import { codexAdapter } from '../adapters/codex/adapter.js'
import { getCodexManagedHookEntries } from '../adapters/codex/hooks.js'
import { cursorLayout } from '../adapters/layouts/cursor.js'
import { buildAbsoluteRunnerInvocation, resolveScopedPaths } from '../adapters/layouts/scope.js'
import { doctorProject } from '../commands/doctor.js'
import { metricsProject } from '../commands/metrics.js'
import { loadConfigFile, pendingApprovalsPath } from '../config-io.js'
import { runtimeIntegrityFiles } from '../core/integrity.js'
import { getManagedHookEntries } from '../defaults.js'
import { initProject, uninstallProject, upgradeProject } from '../installer.js'
import { PACKAGE_VERSION } from '../version.js'

const tempDirs: string[] = []
const originalHome = process.env.HOME
const originalPath = process.env.PATH
const originalSystemRoot = process.env.SystemRoot
const exec = promisify(execCallback)
const execFile = promisify(execFileCallback)

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

async function runInstalledCursorShellGate(
  hooksPath: string,
  actionRepoRoot: string,
): Promise<Record<string, unknown>> {
  const hooks = JSON.parse(await readFile(hooksPath, 'utf8')) as {
    hooks: { beforeShellExecution?: Array<{ command?: unknown }> }
  }
  const command = hooks.hooks.beforeShellExecution?.[0]?.command
  if (typeof command !== 'string') {
    throw new Error(`missing Cursor shell gate in ${hooksPath}`)
  }
  const result = spawnSync(command, {
    cwd: actionRepoRoot,
    env: { ...process.env, BELAY_DETERMINISTIC_JUDGE: '1' },
    input: JSON.stringify({ command: 'git push origin main', cwd: actionRepoRoot }),
    encoding: 'utf8',
    shell: true,
    timeout: 15_000,
  })
  if (result.status !== 0) {
    throw new Error(`Cursor shell gate failed (${result.status}): ${result.stderr}`)
  }
  return JSON.parse(result.stdout.trim()) as Record<string, unknown>
}

describe('installer scope (T29)', () => {
  afterEach(async () => {
    vi.restoreAllMocks()
    process.env.HOME = originalHome
    process.env.PATH = originalPath
    if (originalSystemRoot === undefined) {
      delete process.env.SystemRoot
    } else {
      process.env.SystemRoot = originalSystemRoot
    }
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
  })

  it('executes an absolute runner path with spaces and shell metacharacters literally', async () => {
    const repoRoot = await createTempRepo()
    const injectionMarker = path.join(repoRoot, 'injected-marker')
    const hooksDir = path.join(
      repoRoot,
      process.platform === 'win32'
        ? 'hooks %TEMP% !BELAY_TEST_NAME! space & mkdir injected-marker & literal'
        : "hooks $(mkdir injected-marker) ; amp & quote' literal",
    )
    await mkdir(hooksDir, { recursive: true })
    const runnerPath = path.join(
      hooksDir,
      process.platform === 'win32' ? 'belay-runner.ps1' : 'belay-runner',
    )
    await writeFile(
      runnerPath,
      process.platform === 'win32'
        ? 'Write-Output $args[0]\r\nWrite-Output $args[1]\r\n'
        : '#!/bin/sh\nprintf \'%s\\n\' "$@"\n',
    )
    if (process.platform !== 'win32') {
      await chmod(runnerPath, 0o755)
    }

    const command = buildAbsoluteRunnerInvocation(
      process.platform,
      hooksDir,
      'belay-shell-gate',
      'preToolUse',
    )
    const result =
      process.platform === 'win32'
        ? await execFile(process.env.ComSpec ?? 'cmd.exe', ['/d', '/v:on', '/s', '/c', command], {
            cwd: repoRoot,
            env: {
              ...process.env,
              TEMP: 'expanded-temp-segment',
              BELAY_TEST_NAME: 'expanded-bang-segment',
            },
          })
        : await exec(command, { cwd: repoRoot })

    expect(result.stdout.trim()).toBe('belay-shell-gate\npreToolUse')
    expect(existsSync(injectionMarker)).toBe(false)
  })

  it('uses a trusted absolute PowerShell path despite hostile cwd and PATH executables', async () => {
    const hostileRoot = await createTempRepo()
    const hooksDir = path.join(hostileRoot, 'hooks %TEMP% !BELAY_TEST_NAME! & space')
    await mkdir(hooksDir, { recursive: true })
    await writeFile(path.join(hostileRoot, 'powershell.exe'), 'hostile workspace executable\n')
    process.env.PATH = hostileRoot
    process.env.SystemRoot = 'D:\\Trusted Windows\\.\\'
    const previousCwd = process.cwd()
    let command: string
    try {
      process.chdir(hostileRoot)
      command = buildAbsoluteRunnerInvocation('win32', hooksDir, 'belay-shell-gate', 'preToolUse')
    } finally {
      process.chdir(previousCwd)
    }
    const match = command.match(
      /^"D:\\Trusted Windows\\System32\\WindowsPowerShell\\v1\.0\\powershell\.exe" -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand ([A-Za-z0-9+/=]+)$/,
    )

    expect(match?.[1]).toBeDefined()
    expect(command).not.toMatch(/^powershell\.exe\b/i)
    expect(command).not.toContain(hostileRoot)
    expect(command).not.toContain('%TEMP%')
    expect(command).not.toContain('!BELAY_TEST_NAME!')
    const decoded = Buffer.from(match?.[1] ?? '', 'base64').toString('utf16le')
    expect(decoded).toBe(
      `& '${path.join(realpathSync(hooksDir), 'belay-runner.ps1')}' 'belay-shell-gate' 'preToolUse'`,
    )
  })

  it('rejects relative or cmd-expandable Windows system roots', () => {
    for (const systemRoot of [
      'Windows',
      'D:\\Windows%TEMP%',
      'D:\\Windows!BELAY_TEST_NAME!',
      'D:\\Windows&hostile',
      '\\\\host\\Windows',
      'D:\\Win?dows',
      'D:\\Win"dows',
      'D:\\Win\u0001dows',
    ]) {
      process.env.SystemRoot = systemRoot
      expect(() =>
        buildAbsoluteRunnerInvocation('win32', 'D:\\repo\\.cursor\\hooks', 'belay-shell-gate'),
      ).toThrow(/trusted Windows system root/i)
    }
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

  it('keeps the global owner effective when staging a project init fails before publication', async () => {
    const homeDir = await createTempHome()
    const repoRoot = await createTempRepo()
    await initProject({ targetDir: repoRoot, scope: 'global' })
    const projectRuntimePath = path.join(repoRoot, '.cursor', 'belay', 'runtime')
    await rm(projectRuntimePath, { recursive: true, force: true })
    await writeFile(projectRuntimePath, 'blocks runtime directory creation\n')

    await expect(initProject({ targetDir: repoRoot, scope: 'project' })).rejects.toThrow()

    expect((await loadConfigFile(repoRoot, 'cursor')).installScope).toBe('global')
    await expect(
      runInstalledCursorShellGate(path.join(homeDir, '.cursor', 'hooks.json'), repoRoot),
    ).resolves.toMatchObject({ permission: 'deny' })
    expect(existsSync(path.join(homeDir, '.cursor', 'belay', 'runtime', 'dispatcher.mjs'))).toBe(
      true,
    )
  })

  it('keeps the project owner effective when staging a global upgrade fails before publication', async () => {
    const homeDir = await createTempHome()
    const repoRoot = await createTempRepo()
    await initProject({ targetDir: repoRoot, scope: 'project' })
    const globalSkillsDir = path.join(homeDir, '.cursor', 'skills')
    await mkdir(globalSkillsDir, { recursive: true })
    await writeFile(path.join(globalSkillsDir, 'belay'), 'blocks skill directory creation\n')

    await expect(
      upgradeProject({ targetDir: repoRoot, scope: 'global', withSkill: true }),
    ).rejects.toThrow()

    expect((await loadConfigFile(repoRoot, 'cursor')).installScope).toBe('project')
    expect(existsSync(path.join(homeDir, '.cursor', 'belay', 'runtime', 'dispatcher.mjs'))).toBe(
      true,
    )
    expect(existsSync(path.join(homeDir, '.cursor', 'hooks.json'))).toBe(true)
    await expect(
      runInstalledCursorShellGate(path.join(repoRoot, '.cursor', 'hooks.json'), repoRoot),
    ).resolves.toMatchObject({ permission: 'deny' })
    expect(existsSync(path.join(repoRoot, '.cursor', 'belay', 'runtime', 'dispatcher.mjs'))).toBe(
      true,
    )
  })

  it.runIf(process.platform !== 'win32')(
    'upgrades through a symlink without duplicating canonical-equivalent managed hooks',
    async () => {
      const repoRoot = await createTempRepo()
      const linkParent = await createTempRepo()
      const linkedRepo = path.join(linkParent, 'repo-link')
      await symlink(repoRoot, linkedRepo, 'dir')
      await initProject({ targetDir: repoRoot })
      const hooksPath = path.join(repoRoot, '.cursor', 'hooks.json')
      const before = JSON.parse(await readFile(hooksPath, 'utf8')) as {
        hooks: Record<string, Array<{ command: string; matcher?: string }>>
      }
      const originalShellCommand = before.hooks.beforeShellExecution?.[0]?.command

      await upgradeProject({ targetDir: linkedRepo })

      const after = JSON.parse(await readFile(hooksPath, 'utf8')) as {
        hooks: Record<string, Array<{ command: string; matcher?: string }>>
      }
      expect(after.hooks.beforeShellExecution).toHaveLength(1)
      expect(after.hooks.beforeShellExecution?.[0]?.command).toBe(originalShellCommand)
      expect(after.hooks.preToolUse?.filter((entry) => entry.matcher === 'Shell')).toHaveLength(1)
      const report = await doctorProject({ targetDir: linkedRepo })
      expect(report.ok).toBe(true)
      expect(report.issues.some((issue) => issue.includes('Missing managed hook'))).toBe(false)
    },
  )

  it('global selection removes only stale exact project hooks and artifacts for the current repo', async () => {
    await createTempHome()
    const repoRoot = await createTempRepo()
    const siblingRoot = await createTempRepo()
    await initProject({ targetDir: repoRoot, withSkill: true })
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
    const unknownArtifacts = [
      path.join(repoRoot, '.cursor', 'hooks', 'custom-hook'),
      path.join(repoRoot, '.cursor', 'belay', 'runtime', 'custom-runtime.mjs'),
      path.join(repoRoot, '.cursor', 'skills', 'belay', 'custom-skill-note.md'),
      path.join(repoRoot, '.cursor', 'commands', 'custom-command.md'),
    ]
    for (const artifactPath of unknownArtifacts) {
      await writeFile(artifactPath, `preserve:${path.basename(artifactPath)}\n`)
    }

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
    expect(existsSync(path.join(repoRoot, '.cursor', 'skills', 'belay', 'SKILL.md'))).toBe(false)
    for (const fileName of [
      'belay-approve.md',
      'belay-why.md',
      'belay-explain.md',
      'belay-status.md',
      'belay-report.md',
      'belay-recover.md',
    ]) {
      expect(existsSync(path.join(repoRoot, '.cursor', 'commands', fileName))).toBe(false)
    }
    for (const artifactPath of unknownArtifacts) {
      await expect(readFile(artifactPath, 'utf8')).resolves.toBe(
        `preserve:${path.basename(artifactPath)}\n`,
      )
    }
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
    expect(shellCommand).toBe(
      buildAbsoluteRunnerInvocation(
        process.platform,
        path.join(homeDir, '.cursor', 'hooks'),
        'belay-shell-gate',
      ),
    )
    expect(shellCommand).not.toMatch(/^\.\//)
  })

  it('integrity manifest pins the global Cursor settings, shims, runners, and runtime', async () => {
    const homeDir = await createTempHome()
    const repoRoot = await createTempRepo()
    await initProject({ targetDir: repoRoot, scope: 'global' })

    const paths = resolveScopedPaths(cursorLayout, 'global', repoRoot)
    const files = runtimeIntegrityFiles(cursorLayout, paths)
    const expectedFiles = [
      paths.configPath,
      paths.hooksSettingsPath,
      path.join(paths.hooksDir, 'belay-before-submit.mjs'),
      path.join(paths.hooksDir, 'belay-shell-gate.mjs'),
      path.join(paths.hooksDir, 'belay-tool-gate.mjs'),
      path.join(paths.hooksDir, 'belay-audit.mjs'),
      path.join(paths.hooksDir, 'belay-runner'),
      path.join(paths.hooksDir, 'belay-runner.cmd'),
      path.join(paths.hooksDir, 'belay-runner.ps1'),
      path.join(paths.runtimeDir, 'core.mjs'),
      path.join(paths.runtimeDir, 'dispatcher.mjs'),
    ]
    expect(files).toEqual(expectedFiles)

    const manifestPath = path.join(repoRoot, '.cursor', 'belay', 'integrity-manifest.json')
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as {
      files: Record<string, string>
    }
    expect(Object.keys(manifest.files)).toEqual([
      '.cursor/belay.config.json',
      '@global/hooks.json',
      '@global/hooks/belay-before-submit.mjs',
      '@global/hooks/belay-shell-gate.mjs',
      '@global/hooks/belay-tool-gate.mjs',
      '@global/hooks/belay-audit.mjs',
      '@global/hooks/belay-runner',
      '@global/hooks/belay-runner.cmd',
      '@global/hooks/belay-runner.ps1',
      '@global/belay/runtime/core.mjs',
      '@global/belay/runtime/dispatcher.mjs',
    ])
    expect(existsSync(path.join(homeDir, '.cursor', 'hooks', 'belay-tool-gate.mjs'))).toBe(true)
  })

  it('refreshes every global Cursor integrity pin on upgrade', async () => {
    const homeDir = await createTempHome()
    const repoRoot = await createTempRepo()
    await initProject({ targetDir: repoRoot, scope: 'global' })
    const dispatcherPath = path.join(homeDir, '.cursor', 'belay', 'runtime', 'dispatcher.mjs')
    await writeFile(dispatcherPath, `${await readFile(dispatcherPath, 'utf8')}\n// tampered\n`)

    await upgradeProject({ targetDir: repoRoot, scope: 'global' })

    const manifest = JSON.parse(
      await readFile(path.join(repoRoot, '.cursor', 'belay', 'integrity-manifest.json'), 'utf8'),
    ) as { files: Record<string, string> }
    for (const manifestKey of [
      '@global/hooks.json',
      '@global/hooks/belay-shell-gate.mjs',
      '@global/hooks/belay-runner',
      '@global/hooks/belay-runner.cmd',
      '@global/hooks/belay-runner.ps1',
      '@global/belay/runtime/core.mjs',
      '@global/belay/runtime/dispatcher.mjs',
    ]) {
      expect(manifest.files[manifestKey]).toMatch(/^[a-f0-9]{64}$/)
    }
    await expect(doctorProject({ targetDir: repoRoot })).resolves.toMatchObject({ ok: true })
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
      buildAbsoluteRunnerInvocation(process.platform, hooksDir, 'belay-shell-gate'),
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
    expect(existsSync(path.join(homeDir, '.claude', 'hooks', 'belay-runner.ps1'))).toBe(false)
    const config = await loadConfigFile(repoRoot, 'claude')
    expect(config.installScope).toBe('global')
  })

  it('codex global scope writes hooks under HOME', async () => {
    const homeDir = await createTempHome()
    const repoRoot = await createTempRepo()
    await mkdir(path.join(repoRoot, '.git'))
    await codexAdapter.install(repoRoot, { scope: 'global', withSkill: true })

    expect(existsSync(path.join(homeDir, '.codex', 'hooks', 'belay-runner'))).toBe(true)
    expect(existsSync(path.join(homeDir, '.codex', 'hooks', 'belay-runner.ps1'))).toBe(false)
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
    expect(existsSync(path.join(homeDir, '.cursor', 'hooks', 'belay-runner.ps1'))).toBe(false)
    expect(existsSync(path.join(homeDir, '.cursor', 'belay', 'runtime', 'core.mjs'))).toBe(false)
    expect(existsSync(path.join(homeDir, '.cursor', 'belay', 'runtime', 'dispatcher.mjs'))).toBe(
      false,
    )
    expect(existsSync(path.join(homeDir, '.cursor', 'skills', 'belay', 'SKILL.md'))).toBe(false)
  })
})
