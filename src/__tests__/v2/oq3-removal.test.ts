import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'
import { doctorProject } from '../../commands/doctor.js'
import { loadConfigFile, writeConfigFile } from '../../config-io.js'
import { DEFAULT_CONFIG_V4, normalizeConfig } from '../../core/config.js'
import { initProject } from '../../installer.js'

const tempDirs: string[] = []

async function createTempRepo() {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'agent-belay-oq3-removal-'))
  tempDirs.push(tempDir)
  return tempDir
}

describe('T17 OQ3 / control-plane spike removal', () => {
  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
  })

  it('loads legacy spikeOnPrompt without error and strips on write', async () => {
    const repoRoot = await createTempRepo()
    await initProject({ targetDir: repoRoot })
    const configPath = path.join(repoRoot, '.cursor', 'belay.config.json')
    const raw = JSON.parse(await readFile(configPath, 'utf8'))
    raw.controlPlane = { ...raw.controlPlane, spikeOnPrompt: true }
    await writeFile(configPath, `${JSON.stringify(raw, null, 2)}\n`)

    const loaded = await loadConfigFile(repoRoot)
    expect('spikeOnPrompt' in loaded.controlPlane).toBe(false)

    await writeConfigFile(repoRoot, loaded)
    const rewritten = JSON.parse(await readFile(configPath, 'utf8'))
    expect(rewritten.controlPlane?.spikeOnPrompt).toBeUndefined()
  })

  it('doctor does not report OQ3 or isolation spike notes', async () => {
    const repoRoot = await createTempRepo()
    await initProject({ targetDir: repoRoot })
    const report = await doctorProject({ targetDir: repoRoot })
    const combined = [...report.notes, ...report.warnings, ...report.issues].join('\n')
    expect(combined.toLowerCase()).not.toContain('oq3 spike')
    expect(combined.toLowerCase()).not.toContain('spikeonprompt')
    expect(combined.toLowerCase()).not.toContain('control-plane spike')
  })

  it('normalizeConfig drops unknown control-plane spike fields', () => {
    const normalized = normalizeConfig({
      ...DEFAULT_CONFIG_V4,
      controlPlane: {
        ...DEFAULT_CONFIG_V4.controlPlane,
        spikeOnPrompt: true,
      } as typeof DEFAULT_CONFIG_V4.controlPlane & { spikeOnPrompt: boolean },
    })
    expect('spikeOnPrompt' in normalized.controlPlane).toBe(false)
  })
})
