import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'
import { mergeConfig } from '../core/config.js'
import { dogfoodProject } from '../dogfood.js'
import { initProject } from '../installer.js'
import { loadOperationalInsights, readOq3SpikeStatus } from '../operational-insights.js'
import { statusProject } from '../status.js'

const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

describe('dogfood command', () => {
  it('enables audit mode with fail-closed policy and spikeOnPrompt', async () => {
    const repoRoot = await mkdtemp(path.join(os.tmpdir(), 'belay-dogfood-'))
    tempDirs.push(repoRoot)
    await initProject({ targetDir: repoRoot })

    const result = await dogfoodProject({ targetDir: repoRoot })
    expect(result.ok).toBe(true)
    expect(result.mode).toBe('audit')
    expect(result.unknownLocalEffect).toBe('deny')
    expect(result.spikeOnPrompt).toBe(true)

    const config = JSON.parse(
      await readFile(path.join(repoRoot, '.cursor', 'belay.config.json'), 'utf8'),
    )
    expect(config.mode).toBe('audit')
    expect(config.policy.unknownLocalEffect).toBe('deny')
    expect(config.controlPlane.spikeOnPrompt).toBe(true)
  })

  it('promotes to enforce when metrics are ready', async () => {
    const repoRoot = await mkdtemp(path.join(os.tmpdir(), 'belay-dogfood-enforce-'))
    tempDirs.push(repoRoot)
    await initProject({ targetDir: repoRoot, dogfood: true })
    await writeFile(
      path.join(repoRoot, '.cursor', 'belay', 'audit.ndjson'),
      `${JSON.stringify({
        event: 'beforeShellExecution',
        kind: 'shell',
        verdict: 'allow',
        reason: 'read_only',
        wouldBlock: false,
        mode: 'audit',
      })}\n`,
    )

    const result = await dogfoodProject({ targetDir: repoRoot, enforce: true })
    expect(result.ok).toBe(true)
    expect(result.mode).toBe('enforce')

    const config = JSON.parse(
      await readFile(path.join(repoRoot, '.cursor', 'belay.config.json'), 'utf8'),
    )
    expect(config.mode).toBe('enforce')
    expect(config.controlPlane.spikeOnPrompt).toBe(false)
  })

  it('refuses enforce until metrics are ready unless forced', async () => {
    const repoRoot = await mkdtemp(path.join(os.tmpdir(), 'belay-dogfood-force-'))
    tempDirs.push(repoRoot)
    await initProject({ targetDir: repoRoot, dogfood: true })

    const blocked = await dogfoodProject({ targetDir: repoRoot, enforce: true })
    expect(blocked.ok).toBe(false)

    const forced = await dogfoodProject({ targetDir: repoRoot, enforce: true, force: true })
    expect(forced.ok).toBe(true)
    expect(forced.mode).toBe('enforce')
  })

  it('surfaces dogfood and OQ3 spike in status', async () => {
    const repoRoot = await mkdtemp(path.join(os.tmpdir(), 'belay-dogfood-status-'))
    tempDirs.push(repoRoot)
    const controlPlaneDir = path.join(repoRoot, 'cp')
    await initProject({ targetDir: repoRoot })
    await dogfoodProject({ targetDir: repoRoot, spikeOnPrompt: true })
    await mkdir(controlPlaneDir, { recursive: true })
    await writeFile(
      path.join(controlPlaneDir, 'oq3-spike-last.json'),
      `${JSON.stringify({
        ok: true,
        recordedAt: '2026-06-10T00:00:00.000Z',
        controlPlaneDir,
      })}\n`,
    )
    await writeFile(
      path.join(repoRoot, '.cursor', 'belay.config.json'),
      `${JSON.stringify(
        mergeConfig({
          mode: 'audit',
          policy: { unknownLocalEffect: 'deny' },
          controlPlane: { enabled: false, configDir: controlPlaneDir, spikeOnPrompt: true },
        }),
        null,
        2,
      )}\n`,
    )

    const status = await statusProject({ targetDir: repoRoot })
    expect(status.dogfood.active).toBe(true)
    expect(status.oq3Spike?.ok).toBe(true)

    const insights = await loadOperationalInsights({ targetDir: repoRoot })
    const spike = await readOq3SpikeStatus(
      mergeConfig({
        controlPlane: { enabled: false, configDir: controlPlaneDir },
      }),
    )
    expect(spike?.ok).toBe(true)
    expect(insights.dogfood.active).toBe(true)
  })
})
