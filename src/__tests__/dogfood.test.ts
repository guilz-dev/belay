import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'
import { dogfoodProject } from '../commands/dogfood.js'
import { statusProject } from '../commands/status.js'
import { mergeConfig } from '../core/config.js'
import { initProject } from '../installer.js'
import { loadOperationalInsights } from '../operational-insights.js'

const tempDirs: string[] = []

function auditAllowLine(): string {
  return `${JSON.stringify({
    event: 'beforeShellExecution',
    kind: 'shell',
    verdict: 'allow',
    reason: 'read_only',
    wouldBlock: false,
    mode: 'audit',
  })}\n`
}

async function seedDogfoodEnforceReady(repoRoot: string): Promise<void> {
  const config = mergeConfig({
    mode: 'audit',
    policy: { unknownLocalEffect: 'deny', unparseableShell: 'deny' },
    controlPlane: {
      enabled: false,
      configDir: null,
      integrity: 'none',
    },
    audit: { logPath: '.cursor/belay/audit.ndjson', includeAssessment: true },
  })
  await writeFile(path.join(repoRoot, config.audit.logPath), auditAllowLine().repeat(20))
  await writeFile(
    path.join(repoRoot, '.cursor', 'belay.config.json'),
    `${JSON.stringify(config, null, 2)}\n`,
  )
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

describe('dogfood command', () => {
  it('init --preset l1-full-recommended --dogfood keeps preset layers but sets audit mode', async () => {
    const repoRoot = await mkdtemp(path.join(os.tmpdir(), 'belay-dogfood-preset-'))
    tempDirs.push(repoRoot)
    await initProject({ targetDir: repoRoot, preset: 'l1-full-recommended', dogfood: true })

    const config = JSON.parse(
      await readFile(path.join(repoRoot, '.cursor', 'belay.config.json'), 'utf8'),
    )
    expect(config.mode).toBe('audit')
    expect(config.sandbox.enabled).toBe(true)
    expect(config.egress.enabled).toBe(true)
    expect(config.approvalSigning.required).toBe(true)
    expect(config.controlPlane.isolation.mode).toBe('separate-user')
    expect(config.policy.unknownLocalEffect).toBe('deny')
    expect(config.controlPlane.spikeOnPrompt).toBeUndefined()
  })

  it('enables audit mode with fail-closed policy', async () => {
    const repoRoot = await mkdtemp(path.join(os.tmpdir(), 'belay-dogfood-'))
    tempDirs.push(repoRoot)
    await initProject({ targetDir: repoRoot })

    const result = await dogfoodProject({ targetDir: repoRoot })
    expect(result.ok).toBe(true)
    expect(result.mode).toBe('audit')
    expect(result.unknownLocalEffect).toBe('deny')

    const config = JSON.parse(
      await readFile(path.join(repoRoot, '.cursor', 'belay.config.json'), 'utf8'),
    )
    expect(config.mode).toBe('audit')
    expect(config.policy.unknownLocalEffect).toBe('deny')
  })

  it('promotes to enforce when metrics are ready', async () => {
    const repoRoot = await mkdtemp(path.join(os.tmpdir(), 'belay-dogfood-enforce-'))
    tempDirs.push(repoRoot)
    await initProject({ targetDir: repoRoot, dogfood: true })
    await seedDogfoodEnforceReady(repoRoot)

    const result = await dogfoodProject({ targetDir: repoRoot, enforce: true })
    expect(result.ok).toBe(true)
    expect(result.mode).toBe('enforce')

    const config = JSON.parse(
      await readFile(path.join(repoRoot, '.cursor', 'belay.config.json'), 'utf8'),
    )
    expect(config.mode).toBe('enforce')
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

  it('surfaces dogfood status without OQ3 spike fields', async () => {
    const repoRoot = await mkdtemp(path.join(os.tmpdir(), 'belay-dogfood-status-'))
    tempDirs.push(repoRoot)
    await initProject({ targetDir: repoRoot })
    await dogfoodProject({ targetDir: repoRoot })
    await writeFile(
      path.join(repoRoot, '.cursor', 'belay.config.json'),
      `${JSON.stringify(
        mergeConfig({
          mode: 'audit',
          policy: { unknownLocalEffect: 'deny' },
        }),
        null,
        2,
      )}\n`,
    )

    const status = await statusProject({ targetDir: repoRoot })
    expect(status.dogfood.active).toBe(true)
    expect('oq3Spike' in status).toBe(false)

    const insights = await loadOperationalInsights({ targetDir: repoRoot })
    expect(insights.dogfood.active).toBe(true)
    expect('oq3Spike' in insights).toBe(false)
  })
})
