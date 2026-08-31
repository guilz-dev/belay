import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'
import { doctorProject } from '../commands/doctor.js'
import { collectHealthSnapshot } from '../commands/health-snapshot.js'
import { initProject } from '../installer.js'

const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

describe('doctor skill-only advisory (T21)', () => {
  it('warns when skill is present but hook floor is missing', async () => {
    const repoRoot = await mkdtemp(path.join(os.tmpdir(), 'belay-skill-only-'))
    tempDirs.push(repoRoot)
    await mkdir(path.join(repoRoot, '.cursor', 'skills', 'belay'), { recursive: true })
    await writeFile(
      path.join(repoRoot, '.cursor', 'skills', 'belay', 'SKILL.md'),
      '---\nname: belay\n---\n',
    )

    const health = await collectHealthSnapshot({ targetDir: repoRoot })
    expect(health.skillInstalled).toBe(true)
    expect(health.floorInstalled).toBe(false)
    expect(health.skillOnly).toBe(true)

    const report = await doctorProject({ targetDir: repoRoot })
    expect(
      report.warnings.some(
        (warning) => warning.includes('Skill-only install detected') && warning.includes('init'),
      ),
    ).toBe(true)
  })

  it('warns when Cursor allowlist can deny actions after Belay allows them', async () => {
    const repoRoot = await mkdtemp(path.join(os.tmpdir(), 'belay-cursor-run-mode-'))
    const homeDir = await mkdtemp(path.join(os.tmpdir(), 'belay-cursor-home-'))
    tempDirs.push(repoRoot, homeDir)
    await initProject({ targetDir: repoRoot, dogfood: true })
    await mkdir(path.join(homeDir, '.cursor'), { recursive: true })
    await writeFile(
      path.join(homeDir, '.cursor', 'cli-config.json'),
      `${JSON.stringify({
        version: 1,
        approvalMode: 'allowlist',
        permissions: { allow: ['Shell(ls)'], deny: [] },
        sandbox: { mode: 'disabled' },
      })}\n`,
    )

    const health = await collectHealthSnapshot({
      targetDir: repoRoot,
      homeDir,
      cursorConfigEnv: {},
    })

    expect(
      health.additionalRiskSignals.some(
        (signal) =>
          signal.includes('Cursor approval mode is allowlist') &&
          signal.includes('after Belay allows') &&
          signal.includes('audit mode'),
      ),
    ).toBe(true)
  })

  it.each([
    ['CURSOR_CONFIG_DIR', (root: string) => root],
    ['XDG_CONFIG_HOME', (root: string) => path.join(root, 'cursor')],
  ])('reads Cursor approval mode from %s', async (envName, configDir) => {
    const repoRoot = await mkdtemp(path.join(os.tmpdir(), 'belay-cursor-env-repo-'))
    const homeDir = await mkdtemp(path.join(os.tmpdir(), 'belay-cursor-env-home-'))
    const envRoot = await mkdtemp(path.join(os.tmpdir(), 'belay-cursor-env-config-'))
    tempDirs.push(repoRoot, homeDir, envRoot)
    await initProject({ targetDir: repoRoot, dogfood: true })
    await mkdir(configDir(envRoot), { recursive: true })
    await writeFile(
      path.join(configDir(envRoot), 'cli-config.json'),
      `${JSON.stringify({ version: 1, approvalMode: 'allowlist' })}\n`,
    )
    const health = await collectHealthSnapshot({
      targetDir: repoRoot,
      homeDir,
      cursorConfigEnv: { [envName]: envRoot },
    })
    expect(
      health.additionalRiskSignals.some((signal) => signal.includes('after Belay allows')),
    ).toBe(true)
  })
})
