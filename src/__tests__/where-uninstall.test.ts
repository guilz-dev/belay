import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { formatWhereReport, whereProject } from '../commands/where.js'
import { initProject, uninstallProject } from '../installer.js'

const tempDirs: string[] = []
const originalHome = process.env.HOME

async function createTempRepo() {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'agent-belay-where-'))
  tempDirs.push(tempDir)
  return tempDir
}

async function createTempHome() {
  const homeDir = await mkdtemp(path.join(os.tmpdir(), 'agent-belay-where-home-'))
  tempDirs.push(homeDir)
  process.env.HOME = homeDir
  return homeDir
}

function belayHookEntries(hooks: Record<string, unknown[]>): unknown[] {
  return Object.values(hooks)
    .flat()
    .filter((entry) => {
      const command =
        entry && typeof entry === 'object' && 'command' in entry
          ? String((entry as { command?: string }).command ?? '')
          : ''
      return command.includes('belay-runner')
    })
}

describe('where command', () => {
  afterEach(async () => {
    process.env.HOME = originalHome
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
  })

  it('reports cwd, target dir, and install paths for project scope', async () => {
    const repoRoot = await createTempRepo()
    await initProject({ targetDir: repoRoot })

    const report = await whereProject({ targetDir: repoRoot })
    expect(report.repoRoot).toBe(repoRoot)
    expect(report.installScope).toBe('project')
    expect(report.configPresent).toBe(true)
    expect(report.hooksDir).toBe(path.join(repoRoot, '.cursor', 'hooks'))
    expect(report.runtimeDir).toBe(path.join(repoRoot, '.cursor', 'belay', 'runtime'))
    expect(report.configPath).toBe(path.join(repoRoot, '.cursor', 'belay.config.json'))
    expect(existsSync(report.cliPackageRoot)).toBe(true)
    expect(formatWhereReport(report)).toContain(`target dir: ${repoRoot}`)
  })

  it('reports global install paths when scope is global', async () => {
    const homeDir = await createTempHome()
    const repoRoot = await createTempRepo()
    await initProject({ targetDir: repoRoot, scope: 'global' })

    const report = await whereProject({ targetDir: repoRoot })
    expect(report.installScope).toBe('global')
    expect(report.hooksDir).toBe(path.join(homeDir, '.cursor', 'hooks'))
    expect(report.runtimeDir).toBe(path.join(homeDir, '.cursor', 'belay', 'runtime'))
    expect(report.configPath).toBe(path.join(repoRoot, '.cursor', 'belay.config.json'))
  })
})

describe('uninstall command', () => {
  afterEach(async () => {
    process.env.HOME = originalHome
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
  })

  it('removes project-scoped hook artifacts and skill extras', async () => {
    const repoRoot = await createTempRepo()
    await initProject({ targetDir: repoRoot, withSkill: true })

    const hooksPath = path.join(repoRoot, '.cursor', 'hooks.json')
    const hooksDir = path.join(repoRoot, '.cursor', 'hooks')
    expect(existsSync(path.join(hooksDir, 'belay-runner'))).toBe(true)
    expect(existsSync(path.join(hooksDir, 'belay-before-submit.mjs'))).toBe(true)

    const result = await uninstallProject({ targetDir: repoRoot })
    expect(result.scope).toBe('project')

    const hooksAfter = JSON.parse(await readFile(hooksPath, 'utf8')) as {
      hooks: Record<string, unknown[]>
    }
    expect(belayHookEntries(hooksAfter.hooks)).toHaveLength(0)
    expect(existsSync(path.join(hooksDir, 'belay-runner'))).toBe(false)
    expect(existsSync(path.join(hooksDir, 'belay-before-submit.mjs'))).toBe(false)
    expect(existsSync(path.join(repoRoot, '.cursor', 'belay', 'runtime', 'core.mjs'))).toBe(false)
    expect(existsSync(path.join(repoRoot, '.cursor', 'skills', 'belay', 'SKILL.md'))).toBe(false)
  })

  it('removes global-scoped hook artifacts from HOME', async () => {
    const homeDir = await createTempHome()
    const repoRoot = await createTempRepo()
    await initProject({ targetDir: repoRoot, scope: 'global', withSkill: true })

    const hooksPath = path.join(homeDir, '.cursor', 'hooks.json')
    const hooksDir = path.join(homeDir, '.cursor', 'hooks')
    expect(existsSync(path.join(hooksDir, 'belay-runner'))).toBe(true)
    expect(existsSync(path.join(hooksDir, 'belay-before-submit.mjs'))).toBe(true)

    const result = await uninstallProject({ targetDir: repoRoot, scope: 'global' })
    expect(result.scope).toBe('global')

    const hooksAfter = JSON.parse(await readFile(hooksPath, 'utf8')) as {
      hooks: Record<string, unknown[]>
    }
    expect(belayHookEntries(hooksAfter.hooks)).toHaveLength(0)
    expect(existsSync(path.join(hooksDir, 'belay-runner'))).toBe(false)
    expect(existsSync(path.join(hooksDir, 'belay-before-submit.mjs'))).toBe(false)
    expect(existsSync(path.join(homeDir, '.cursor', 'belay', 'runtime', 'core.mjs'))).toBe(false)
    expect(existsSync(path.join(homeDir, '.cursor', 'skills', 'belay', 'SKILL.md'))).toBe(false)
  })

  it('does not create hooks.json when belay was never installed', async () => {
    const repoRoot = await createTempRepo()
    const hooksPath = path.join(repoRoot, '.cursor', 'hooks.json')

    await uninstallProject({ targetDir: repoRoot })

    expect(existsSync(hooksPath)).toBe(false)
  })
})
