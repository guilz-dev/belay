import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { doctorProject } from '../doctor.js'
import { initProject } from '../installer.js'

const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

describe('doctorProject', () => {
  it('warns when belay.config.json omits version', async () => {
    const repoRoot = await mkdtemp(path.join(os.tmpdir(), 'belay-doctor-'))
    tempDirs.push(repoRoot)
    await initProject({ targetDir: repoRoot })

    const configPath = path.join(repoRoot, '.cursor', 'belay.config.json')
    const config = JSON.parse(await readFile(configPath, 'utf8'))
    const { version: _version, ...withoutVersion } = config
    await writeFile(configPath, `${JSON.stringify(withoutVersion)}\n`)

    const report = await doctorProject({ targetDir: repoRoot })
    expect(report.warnings.some((warning) => warning.includes('missing "version"'))).toBe(true)
  })

  it('warns when repo-local approval files remain with control plane enabled', async () => {
    const repoRoot = await mkdtemp(path.join(os.tmpdir(), 'belay-doctor-cp-'))
    tempDirs.push(repoRoot)
    await initProject({ targetDir: repoRoot })

    const configPath = path.join(repoRoot, '.cursor', 'belay.config.json')
    const config = JSON.parse(await readFile(configPath, 'utf8'))
    await writeFile(
      configPath,
      `${JSON.stringify({
        ...config,
        version: 3,
        controlPlane: { enabled: true, configDir: path.join(repoRoot, 'cp') },
      })}\n`,
    )

    const report = await doctorProject({ targetDir: repoRoot })
    expect(
      report.warnings.some((warning) => warning.includes('Repo-local approval files remain')),
    ).toBe(true)
  })

  it('archives stale repo-local approvals with doctor --fix when control plane is enabled', async () => {
    const repoRoot = await mkdtemp(path.join(os.tmpdir(), 'belay-doctor-fix-'))
    tempDirs.push(repoRoot)
    const controlPlaneDir = path.join(repoRoot, 'cp')
    await initProject({ targetDir: repoRoot })
    await mkdir(path.join(repoRoot, '.cursor', 'belay'), { recursive: true })
    await writeFile(
      path.join(repoRoot, '.cursor', 'belay', 'pending-approvals.json'),
      `${JSON.stringify({ version: 1, approvals: [] })}\n`,
    )
    await mkdir(controlPlaneDir, { recursive: true })

    const configPath = path.join(repoRoot, '.cursor', 'belay.config.json')
    const config = JSON.parse(await readFile(configPath, 'utf8'))
    await writeFile(
      configPath,
      `${JSON.stringify({
        ...config,
        version: 3,
        controlPlane: { enabled: true, configDir: controlPlaneDir },
      })}\n`,
    )

    const report = await doctorProject({ targetDir: repoRoot, fix: true })
    expect(
      report.notes.some((note) => note.includes('Archived stale repo-local approval files')),
    ).toBe(true)
    expect(existsSync(path.join(repoRoot, '.cursor', 'belay', 'pending-approvals.json'))).toBe(
      false,
    )
  })
})
