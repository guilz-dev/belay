import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { cursorHookRoutingIssues } from '../adapters/cursor/hook-routing-health.js'
import { initProject } from '../installer.js'

const tempDirs: string[] = []

afterEach(async () => {
  while (tempDirs.length > 0) {
    await rm(tempDirs.pop()!, { recursive: true, force: true })
  }
})

describe('cursorHookRoutingIssues', () => {
  it('returns no issues for a healthy project owner', async () => {
    const repoRoot = await mkdtemp(path.join(os.tmpdir(), 'belay-cursor-routing-health-project-'))
    tempDirs.push(repoRoot)
    await initProject({ targetDir: repoRoot, scope: 'project' })

    expect(cursorHookRoutingIssues(repoRoot)).toEqual([])
  })

  it('returns no issues for a healthy global-only owner', async () => {
    const repoRoot = await mkdtemp(path.join(os.tmpdir(), 'belay-cursor-routing-health-global-'))
    const homeDir = await mkdtemp(path.join(os.tmpdir(), 'belay-cursor-routing-health-home-'))
    tempDirs.push(repoRoot, homeDir)
    process.env.HOME = homeDir
    delete process.env.XDG_CONFIG_HOME
    await initProject({ targetDir: repoRoot, scope: 'global' })

    expect(cursorHookRoutingIssues(repoRoot)).toEqual([])
  })

  it('flags an incomplete project owner that the global sentinel would block', async () => {
    const repoRoot = await mkdtemp(path.join(os.tmpdir(), 'belay-cursor-routing-health-incomplete-'))
    tempDirs.push(repoRoot)
    await initProject({ targetDir: repoRoot, scope: 'project' })
    await rm(path.join(repoRoot, '.cursor', 'belay', 'runtime', 'dispatcher.mjs'))

    const issues = cursorHookRoutingIssues(repoRoot)
    expect(issues.length).toBeGreaterThan(0)
    expect(issues.every((issue) => issue.includes('Global Cursor sentinel would block'))).toBe(true)
    expect(issues.some((issue) => issue.includes('belay upgrade --scope project'))).toBe(true)
  })

  it('flags stale partial project artifacts on an untrusted global-only install', async () => {
    const repoRoot = await mkdtemp(path.join(os.tmpdir(), 'belay-cursor-routing-health-stale-global-'))
    const homeDir = await mkdtemp(path.join(os.tmpdir(), 'belay-cursor-routing-health-stale-home-'))
    tempDirs.push(repoRoot, homeDir)
    process.env.HOME = homeDir
    delete process.env.XDG_CONFIG_HOME
    await initProject({ targetDir: repoRoot, scope: 'global' })
    const configPath = path.join(repoRoot, '.cursor', 'belay.config.json')
    const config = JSON.parse(await readFile(configPath, 'utf8'))
    await writeFile(
      configPath,
      `${JSON.stringify({ ...config, mode: 'audit' })}\n`,
    )
    const hooksDir = path.join(repoRoot, '.cursor', 'hooks')
    const runtimeDir = path.join(repoRoot, '.cursor', 'belay', 'runtime')
    await mkdir(hooksDir, { recursive: true })
    await mkdir(runtimeDir, { recursive: true })
    const runnerPath = path.join(
      hooksDir,
      process.platform === 'win32' ? 'belay-runner.ps1' : 'belay-runner',
    )
    await writeFile(runnerPath, '')
    if (process.platform !== 'win32') {
      await chmod(runnerPath, 0o755)
    }
    await writeFile(path.join(runtimeDir, 'dispatcher.mjs'), '')

    const issues = cursorHookRoutingIssues(repoRoot)
    expect(issues.length).toBeGreaterThan(0)
    expect(issues.some((issue) => issue.includes('belay upgrade --scope global'))).toBe(true)
  })
})
