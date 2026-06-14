import { mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'
import { loadConfigFile } from '../../config-io.js'
import { DEFAULT_CONFIG_V4, migrateConfig, normalizeConfig } from '../../core/config.js'
import {
  CloudJudgeConsentRequiredError,
  JudgeEndpointRequiredError,
  resolveInitJudgeConfig,
  resolveJudgeConfig,
} from '../../core/judge-config.js'
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

  it('writes openai-compatible provider with cloud consent and endpoint', async () => {
    const repoRoot = await createTempRepo()
    await initProject({
      targetDir: repoRoot,
      judgeProvider: 'openai-compatible',
      judgeEndpoint: 'https://api.openai.com/v1',
      acceptCloudJudge: true,
    })
    const config = await loadConfigFile(repoRoot)
    expect(config.version).toBe(4)
    expect(config.judge.provider).toBe('openai-compatible')
    expect(config.judge.endpoint).toBe('https://api.openai.com/v1')
    expect(config.judge.model).toBe('auto')
  })

  it('rejects openai-compatible without cloud consent', async () => {
    const repoRoot = await createTempRepo()
    await expect(
      initProject({
        targetDir: repoRoot,
        judgeProvider: 'openai-compatible',
        judgeEndpoint: 'https://api.openai.com/v1',
      }),
    ).rejects.toBeInstanceOf(CloudJudgeConsentRequiredError)
  })

  it('rejects openai-compatible without endpoint', async () => {
    const repoRoot = await createTempRepo()
    await expect(
      initProject({
        targetDir: repoRoot,
        judgeProvider: 'openai-compatible',
        acceptCloudJudge: true,
      }),
    ).rejects.toBeInstanceOf(JudgeEndpointRequiredError)
  })

  it('defaults fresh init to cursor profile without explicit cloud consent flags', async () => {
    const repoRoot = await createTempRepo()
    await initProject({ targetDir: repoRoot })
    const config = await loadConfigFile(repoRoot)
    expect(config.judge.provider).toBe('openai-compatible')
    expect(config.judge.model).toBe('auto')
    expect(config.judge.endpoint).toBe('https://api.openai.com/v1')
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
      judgeProfile: 'local-ollama',
      judgeProvider: 'ollama',
      judgeModel: 'custom:7b',
    })
    expect(judge.provider).toBe('ollama')
    expect(judge.model).toBe('custom:7b')
  })

  it('supports claude/codex judge profiles as openai-compatible aliases', () => {
    const claude = resolveJudgeConfig({ judgeProfile: 'claude' })
    const codex = resolveJudgeConfig({ judgeProfile: 'codex' })
    expect(claude.provider).toBe('openai-compatible')
    expect(codex.provider).toBe('openai-compatible')
    expect(claude.endpoint).toBe('https://api.openai.com/v1')
    expect(codex.endpoint).toBe('https://api.openai.com/v1')
  })

  it('chooses adapter-matched default judge profile when fresh', () => {
    const claudeDefault = resolveInitJudgeConfig({
      isFresh: true,
      hasExplicitJudgeFlags: false,
      defaultJudgeProfile: 'claude',
    })
    const codexDefault = resolveInitJudgeConfig({
      isFresh: true,
      hasExplicitJudgeFlags: false,
      defaultJudgeProfile: 'codex',
    })
    expect(claudeDefault.provider).toBe('openai-compatible')
    expect(codexDefault.provider).toBe('openai-compatible')
  })

  it('requires consent for explicit openai-compatible provider', () => {
    expect(() =>
      resolveInitJudgeConfig({
        isFresh: true,
        hasExplicitJudgeFlags: true,
        judgeProvider: 'openai-compatible',
        judgeEndpoint: 'https://api.example.com/v1',
      }),
    ).toThrow(CloudJudgeConsentRequiredError)
  })

  it('migrates deprecated cursor provider to openai-compatible', () => {
    const migrated = migrateConfig({
      ...DEFAULT_CONFIG_V4,
      judge: {
        provider: 'cursor',
        model: 'auto',
        endpoint: 'https://api.example.com/v1',
        timeoutMs: 8000,
        keepAlive: null,
      },
    })
    expect(migrated.judge.provider).toBe('openai-compatible')
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
