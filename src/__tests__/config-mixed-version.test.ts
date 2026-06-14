import { describe, expect, it } from 'vitest'

import {
  DEFAULT_CONFIG_V4,
  migrateConfig,
  normalizeConfig,
  normalizeJudgeConfig,
} from '../core/config.js'

describe('mixed-version judge config', () => {
  it('keeps openai-compatible driver when read by legacy normalize path', () => {
    const loaded = normalizeConfig({
      ...DEFAULT_CONFIG_V4,
      judge: {
        provider: 'openai-compatible',
        model: 'gpt-4.1-mini',
        endpoint: 'https://api.openai.com/v1',
        timeoutMs: 8000,
        keepAlive: null,
      },
    })
    expect(loaded.judge.provider).toBe('openai-compatible')
    expect(loaded.judge.provider).not.toBe('ollama')
    expect(loaded.judge.providerId).toBe('openai')
  })

  it('does not collapse openai-compatible to ollama on migrate', () => {
    const migrated = migrateConfig({
      ...DEFAULT_CONFIG_V4,
      judge: {
        provider: 'openai-compatible',
        model: 'auto',
        endpoint: 'https://api.example.com/v1',
        timeoutMs: 8000,
        keepAlive: null,
      },
    })
    expect(migrated.judge.provider).toBe('openai-compatible')
    expect(migrated.judge.model).toBe('gpt-4.1-mini')
  })

  it('preserves driver while adding providerId on normalize', () => {
    const normalized = normalizeJudgeConfig({
      provider: 'ollama',
      model: 'gemma4:e2b',
      endpoint: 'http://localhost:11434',
      timeoutMs: 25000,
      keepAlive: '30m',
    })
    expect(normalized.provider).toBe('ollama')
    expect(normalized.providerId).toBe('local')
  })

  it('does not apply OpenAI default endpoint to endpoint-less openai-compatible', () => {
    const normalized = normalizeJudgeConfig({
      provider: 'openai-compatible',
      model: 'gpt-4.1-mini',
      endpoint: null,
      timeoutMs: 8000,
      keepAlive: null,
    })
    expect(normalized.providerId).toBe('custom')
    expect(normalized.endpoint).toBeNull()
  })
})
