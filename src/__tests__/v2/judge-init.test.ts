import { mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'
import { loadConfigFile } from '../../config-io.js'
import { migrateConfig, normalizeConfig } from '../../core/config.js'
import { resolveJudgeConfig } from '../../core/judge-config.js'
import { initProject } from '../../installer.js'

const tempDirs: string[] = []

async function createTempRepo() {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'agent-belay-judge-init-'))
  tempDirs.push(tempDir)
  return tempDir
}

describe('T11 init judge setup matrix', () => {
  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
  })

  it('writes cursor-composer profile as version 4', async () => {
    const repoRoot = await createTempRepo()
    await initProject({ targetDir: repoRoot, judgeProfile: 'cursor-composer' })
    const config = await loadConfigFile(repoRoot)
    expect(config.version).toBe(4)
    expect(config.judge.provider).toBe('cursor')
    expect(config.judge.model).toBe('auto')
  })

  it('writes local-ollama profile as version 4', async () => {
    const repoRoot = await createTempRepo()
    await initProject({ targetDir: repoRoot, judgeProfile: 'local-ollama' })
    const config = await loadConfigFile(repoRoot)
    expect(config.version).toBe(4)
    expect(config.judge.provider).toBe('ollama')
    expect(config.judge.model).toBe('gemma4:e2b')
  })

  it('prefers explicit provider flags over profile', () => {
    const judge = resolveJudgeConfig({
      judgeProfile: 'cursor-composer',
      judgeProvider: 'ollama',
      judgeModel: 'custom:7b',
    })
    expect(judge.provider).toBe('ollama')
    expect(judge.model).toBe('custom:7b')
  })

  it('migrates v3 without judge to v4 ollama principle default', () => {
    const migrated = migrateConfig({
      version: 3,
      mode: 'audit',
      policy: { modelAssist: { enabled: true, model: 'old-model' } },
    })
    expect(migrated.version).toBe(4)
    expect(migrated.judge.provider).toBe('ollama')
    expect(migrated.judge.model).toBe('gemma4:e2b')
  })

  it('loader reads init-written config', async () => {
    const repoRoot = await createTempRepo()
    await initProject({ targetDir: repoRoot, judgeProvider: 'ollama', judgeModel: 'gemma4:e2b' })
    const raw = JSON.parse(
      await readFile(path.join(repoRoot, '.cursor', 'belay.config.json'), 'utf8'),
    )
    const loaded = normalizeConfig({ ...raw, version: 4 })
    expect(loaded.judge.provider).toBe('ollama')
    expect(loaded.judge.model).toBe('gemma4:e2b')
  })
})
