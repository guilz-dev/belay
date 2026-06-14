import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { claudeAdapter } from '../adapters/claude/adapter.js'
import { codexAdapter } from '../adapters/codex/adapter.js'
import { cursorLayout } from '../adapters/layouts/cursor.js'
import { resolveScopedPaths } from '../adapters/layouts/scope.js'
import { doctorProject } from '../commands/doctor.js'
import { loadConfigFile, pendingApprovalsPath } from '../config-io.js'
import { runtimeIntegrityFiles } from '../core/integrity.js'
import { getManagedHookEntries } from '../defaults.js'
import { initProject, upgradeProject } from '../installer.js'

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
    await initProject({ targetDir: repoRoot, scope: 'global', withSkill: true })

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

  it('project scope runner commands stay repo-relative', async () => {
    const repoRoot = await createTempRepo()
    await initProject({ targetDir: repoRoot })

    const hooksDir = cursorLayout.hooksDir(repoRoot)
    const managed = getManagedHookEntries(process.platform, hooksDir, repoRoot)
    const shellHook = managed.find((entry) => entry.event === 'beforeShellExecution')?.definition
    expect(shellHook?.command).toMatch(/^\.\//)
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
})
