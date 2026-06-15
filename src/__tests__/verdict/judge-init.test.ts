import { mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'
import { loadConfigFile } from '../../config-io.js'
import { DEFAULT_CONFIG_V4, migrateConfig, normalizeConfig } from '../../core/config.js'
import {
  defaultJudgeProviderForAdapter,
  resolveInitJudgeConfig,
  resolveJudgeConfig,
} from '../../core/judge-config.js'
import { initProject } from '../../installer.js'

const tempDirs: string[] = []

function mockStdinTTY(value: boolean): () => void {
  const previous = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY')
  Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value })
  return () => {
    if (previous) {
      Object.defineProperty(process.stdin, 'isTTY', previous)
    } else {
      Reflect.deleteProperty(process.stdin, 'isTTY')
    }
  }
}

async function createTempRepo() {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'agent-belay-judge-init-'))
  tempDirs.push(tempDir)
  return tempDir
}

describe('T11 init judge setup matrix', () => {
  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
  })

  it('writes openai-compatible provider with cloud consent on interactive TTY', async () => {
    const restoreTTY = mockStdinTTY(true)
    const repoRoot = await createTempRepo()
    try {
      await initProject({
        targetDir: repoRoot,
        judgeProvider: 'openai-compatible',
        judgeEndpoint: 'https://api.openai.com/v1',
        acceptCloudJudge: true,
      })
      const config = await loadConfigFile(repoRoot)
      expect(config.version).toBe(4)
      expect(config.judge.provider).toBe('openai-compatible')
      expect(config.judge.providerId).toBe('codex')
      expect(config.judge.endpoint).toBe('https://api.openai.com/v1')
      expect(config.judge.model).toBe('gpt-5.3-codex-high')
      expect(config.judge.cloudConsent?.accepted).toBe(true)
      expect(config.judge.cloudConsent?.by).toBe('tty')
    } finally {
      restoreTTY()
    }
  })

  it('does not record cloud consent for accept-cloud-judge in non-interactive mode', async () => {
    const restoreTTY = mockStdinTTY(false)
    const repoRoot = await createTempRepo()
    try {
      await initProject({
        targetDir: repoRoot,
        judgeProvider: 'openai-compatible',
        judgeEndpoint: 'https://api.openai.com/v1',
        acceptCloudJudge: true,
      })
      const config = await loadConfigFile(repoRoot)
      expect(config.judge.providerId).toBe('codex')
      expect(config.judge.cloudConsent?.accepted).toBeUndefined()
    } finally {
      restoreTTY()
    }
  })

  it('saves openai-compatible without cloud consent (fail-closed at runtime)', async () => {
    const repoRoot = await createTempRepo()
    await initProject({
      targetDir: repoRoot,
      judgeProvider: 'openai-compatible',
      judgeEndpoint: 'https://api.openai.com/v1',
    })
    const config = await loadConfigFile(repoRoot)
    expect(config.judge.provider).toBe('openai-compatible')
    expect(config.judge.cloudConsent?.accepted).toBeUndefined()
  })

  it('allows cursor without endpoint on explicit init', async () => {
    const repoRoot = await createTempRepo()
    await initProject({
      targetDir: repoRoot,
      judgeProviderId: 'cursor',
      acceptCloudJudge: true,
    })
    const config = await loadConfigFile(repoRoot)
    expect(config.judge.providerId).toBe('cursor')
    expect(config.judge.endpoint).toBeNull()
  })

  it('defaults fresh init to cursor judge when adapter is cursor', async () => {
    const repoRoot = await createTempRepo()
    await initProject({ targetDir: repoRoot, adapter: 'cursor' })
    const config = await loadConfigFile(repoRoot)
    expect(config.judge.provider).toBe('openai-compatible')
    expect(config.judge.providerId).toBe('cursor')
    expect(config.judge.model).toBe('composer-2.5')
    expect(config.judge.endpoint).toBeNull()
    expect(config.judge.credential?.mode).toBe('project')
  })

  it('defaults fresh init to claude judge when adapter is claude', async () => {
    const repoRoot = await createTempRepo()
    await initProject({ targetDir: repoRoot, adapter: 'claude' })
    const config = await loadConfigFile(repoRoot)
    expect(config.judge.providerId).toBe('claude')
    expect(config.judge.provider).toBe('anthropic')
    expect(config.judge.endpoint).toBeNull()
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

  it('supports claude/codex judge profiles from catalog', () => {
    const claude = resolveJudgeConfig({ judgeProfile: 'claude' })
    const codex = resolveJudgeConfig({ judgeProfile: 'codex' })
    expect(claude.provider).toBe('anthropic')
    expect(codex.provider).toBe('openai-compatible')
    expect(claude.endpoint).toBeNull()
    expect(codex.endpoint).toBeNull()
  })

  it('defaults fresh init by adapter when no explicit judge flags', () => {
    const cursorDefault = resolveInitJudgeConfig({
      isFresh: true,
      hasExplicitJudgeFlags: false,
      adapter: 'cursor',
    })
    const claudeDefault = resolveInitJudgeConfig({
      isFresh: true,
      hasExplicitJudgeFlags: false,
      adapter: 'claude',
    })
    const codexDefault = resolveInitJudgeConfig({
      isFresh: true,
      hasExplicitJudgeFlags: false,
      adapter: 'codex',
    })
    expect(cursorDefault.providerId).toBe('cursor')
    expect(cursorDefault.provider).toBe('openai-compatible')
    expect(claudeDefault.providerId).toBe('claude')
    expect(claudeDefault.provider).toBe('anthropic')
    expect(codexDefault.providerId).toBe('codex')
    expect(codexDefault.provider).toBe('openai-compatible')
    expect(cursorDefault.credential?.mode).toBe('project')
  })

  it('maps adapter to default judge provider id', () => {
    expect(defaultJudgeProviderForAdapter('cursor')).toBe('cursor')
    expect(defaultJudgeProviderForAdapter('claude')).toBe('claude')
    expect(defaultJudgeProviderForAdapter('codex')).toBe('codex')
  })

  it('maps --judge-provider cursor to cursor providerId without OpenAI default', () => {
    const judge = resolveJudgeConfig({
      judgeProvider: 'cursor',
      judgeEndpoint: 'https://api.cursor.example/v1',
    })
    expect(judge.providerId).toBe('cursor')
    expect(judge.endpoint).toBe('https://api.cursor.example/v1')
    expect(judge.endpoint).not.toContain('api.openai.com')
  })

  it('requires explicit consent flag for legacy resolveInitJudgeConfig without saving consent', () => {
    const judge = resolveInitJudgeConfig({
      isFresh: true,
      hasExplicitJudgeFlags: true,
      judgeProvider: 'openai-compatible',
      judgeEndpoint: 'https://api.example.com/v1',
    })
    expect(judge.cloudConsent?.accepted).toBeUndefined()
  })

  it('records init cloud consent from capability approval id', () => {
    const judge = resolveInitJudgeConfig({
      isFresh: true,
      hasExplicitJudgeFlags: true,
      judgeProviderId: 'codex',
      judgeEndpoint: 'https://api.openai.com/v1',
      cloudConsentApprovalId: 'approval-init',
    })
    expect(judge.cloudConsent?.accepted).toBe(true)
    expect(judge.cloudConsent?.by).toBe('capability-approval:approval-init')
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
