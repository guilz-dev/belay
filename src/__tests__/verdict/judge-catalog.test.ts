import { describe, expect, it, vi } from 'vitest'

import { DEFAULT_CONFIG_V4, normalizeConfig } from '../../core/config.js'
import {
  catalogRequiresEndpoint,
  inferProviderIdFromConfig,
  isRemovedProviderId,
  JUDGE_CATALOG,
  JUDGE_PROVIDER_IDS,
  normalizeLegacyProviderId,
  resolveJudgeFromCatalog,
} from '../../core/verdict/judge-catalog.js'

describe('judge catalog v1', () => {
  it('lists four plan providers', () => {
    expect([...JUDGE_PROVIDER_IDS].sort()).toEqual(['claude', 'codex', 'cursor', 'ollama'])
    expect('anthropic' in JUDGE_CATALOG).toBe(false)
  })

  it('pins codex default model', () => {
    expect(JUDGE_CATALOG.codex.defaultModel).toBe('gpt-5.3-codex-high')
    const resolved = resolveJudgeFromCatalog({ providerId: 'codex' })
    expect(resolved.model).toBe('gpt-5.3-codex-high')
    expect(resolved.endpoint).toBeNull()
  })

  it('does not require endpoint for any catalog provider', () => {
    for (const id of JUDGE_PROVIDER_IDS) {
      expect(catalogRequiresEndpoint(id)).toBe(false)
    }
  })

  it('infers providerId from endpoint hints', () => {
    expect(
      inferProviderIdFromConfig({
        provider: 'openai-compatible',
        endpoint: 'https://api.openai.com/v1',
      }),
    ).toBe('codex')
    expect(
      inferProviderIdFromConfig({
        provider: 'openai-compatible',
        endpoint: 'https://proxy.example.com/v1',
      }),
    ).toBe('codex')
  })

  it('infers codex for endpoint-less openai-compatible without providerId', () => {
    expect(
      inferProviderIdFromConfig({
        provider: 'openai-compatible',
        endpoint: null,
      }),
    ).toBe('codex')
  })

  it('infers cursor for endpoint-less composer model', () => {
    expect(
      inferProviderIdFromConfig({
        provider: 'openai-compatible',
        model: 'composer-2.5',
        endpoint: null,
      }),
    ).toBe('cursor')
  })

  it('normalizes legacy provider ids on read', () => {
    expect(normalizeLegacyProviderId('local')).toBe('ollama')
    expect(normalizeLegacyProviderId('openai')).toBe('codex')
  })

  it('warns and preserves endpoint when loading removed openrouter providerId', () => {
    const warn = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    const loaded = normalizeConfig({
      ...DEFAULT_CONFIG_V4,
      judge: {
        provider: 'openai-compatible',
        providerId: 'openrouter' as 'codex',
        model: 'openai/gpt-4.1-mini',
        endpoint: 'https://openrouter.ai/api/v1',
        timeoutMs: 8000,
        keepAlive: null,
      },
    })
    expect(isRemovedProviderId('openrouter')).toBe(true)
    expect(warn).toHaveBeenCalled()
    expect(loaded.judge.endpoint).toBe('https://openrouter.ai/api/v1')
    expect(loaded.judge.model).toBe('openai/gpt-4.1-mini')
    expect(loaded.judge.providerId).toBe('openrouter')
    warn.mockRestore()
  })
})
