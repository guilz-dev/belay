import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'
import { doctorProject } from '../commands/doctor.js'
import { dogfoodProject } from '../commands/dogfood.js'
import { mergeConfig } from '../core/config.js'
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
    await mkdir(path.join(repoRoot, '.cursor', 'belay'), { recursive: true })
    await writeFile(
      path.join(repoRoot, '.cursor', 'belay', 'pending-approvals.json'),
      `${JSON.stringify({ version: 1, approvals: [{ approvalId: 'belay_stale', kind: 'shell', fingerprint: 'x', repoRoot, reason: 'test', summary: 'x', createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60_000).toISOString() }] }, null, 2)}\n`,
    )
    await writeFile(
      configPath,
      `${JSON.stringify({
        ...config,
        version: 3,
        controlPlane: {
          enabled: true,
          configDir: path.join(repoRoot, 'cp'),
          integrity: 'hash-pinned',
        },
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

  it('reports dogfood state and missing OQ3 spike when spikeOnPrompt is enabled', async () => {
    const repoRoot = await mkdtemp(path.join(os.tmpdir(), 'belay-doctor-dogfood-'))
    tempDirs.push(repoRoot)
    await initProject({ targetDir: repoRoot })
    await dogfoodProject({ targetDir: repoRoot })

    const report = await doctorProject({ targetDir: repoRoot })
    expect(report.dogfood?.active).toBe(true)
    expect(report.oq3Spike).toBeNull()
    expect(
      report.warnings.some((warning) => warning.includes('oq3-spike-last.json is missing')),
    ).toBe(true)
  })

  it('notes successful OQ3 spike in doctor report', async () => {
    const repoRoot = await mkdtemp(path.join(os.tmpdir(), 'belay-doctor-oq3-'))
    tempDirs.push(repoRoot)
    const controlPlaneDir = path.join(repoRoot, 'cp')
    await initProject({ targetDir: repoRoot })
    await mkdir(controlPlaneDir, { recursive: true })
    await writeFile(
      path.join(controlPlaneDir, 'oq3-spike-last.json'),
      `${JSON.stringify({ ok: true, recordedAt: '2026-06-10T00:00:00.000Z', controlPlaneDir })}\n`,
    )
    await writeFile(
      path.join(repoRoot, '.cursor', 'belay.config.json'),
      `${JSON.stringify(
        mergeConfig({
          controlPlane: { enabled: false, configDir: controlPlaneDir, spikeOnPrompt: true },
        }),
        null,
        2,
      )}\n`,
    )

    const report = await doctorProject({ targetDir: repoRoot })
    expect(report.oq3Spike?.ok).toBe(true)
    expect(report.notes.some((note) => note.includes('OQ3 spike passed'))).toBe(true)
  })
})
