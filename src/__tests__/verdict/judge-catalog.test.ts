import { describe, expect, it } from 'vitest'

import {
  catalogRequiresEndpoint,
  inferProviderIdFromConfig,
  JUDGE_CATALOG,
  JUDGE_PROVIDER_IDS,
  resolveJudgeFromCatalog,
} from '../../core/verdict/judge-catalog.js'

describe('judge catalog v1', () => {
  it('lists five providers without anthropic', () => {
    expect(JUDGE_PROVIDER_IDS).toEqual(['local', 'openai', 'cursor', 'openrouter', 'custom'])
    expect('anthropic' in JUDGE_CATALOG).toBe(false)
  })

  it('pins openrouter default model', () => {
    expect(JUDGE_CATALOG.openrouter.defaultModel).toBe('openai/gpt-4.1-mini')
    const resolved = resolveJudgeFromCatalog({ providerId: 'openrouter' })
    expect(resolved.model).toBe('openai/gpt-4.1-mini')
    expect(resolved.endpoint).toBe('https://openrouter.ai/api/v1')
  })

  it('requires endpoint only for cursor and custom', () => {
    expect(catalogRequiresEndpoint('local')).toBe(false)
    expect(catalogRequiresEndpoint('openai')).toBe(false)
    expect(catalogRequiresEndpoint('openrouter')).toBe(false)
    expect(catalogRequiresEndpoint('cursor')).toBe(true)
    expect(catalogRequiresEndpoint('custom')).toBe(true)
  })

  it('infers providerId from endpoint hints', () => {
    expect(
      inferProviderIdFromConfig({
        provider: 'openai-compatible',
        endpoint: 'https://api.openai.com/v1',
      }),
    ).toBe('openai')
    expect(
      inferProviderIdFromConfig({
        provider: 'openai-compatible',
        endpoint: 'https://openrouter.ai/api/v1',
      }),
    ).toBe('openrouter')
    expect(
      inferProviderIdFromConfig({
        provider: 'openai-compatible',
        endpoint: 'https://proxy.example.com/v1',
      }),
    ).toBe('custom')
  })

  it('infers custom for endpoint-less openai-compatible without providerId', () => {
    expect(
      inferProviderIdFromConfig({
        provider: 'openai-compatible',
        endpoint: null,
      }),
    ).toBe('custom')
  })
})
