import { describe, expect, it } from 'vitest'
import { DEFAULT_CONFIG_V4, normalizeConfig } from '../../core/config.js'
import { createDeterministicJudgeStub, createOpenAiCompatibleJudge } from '../../core/v2/judge.js'
import { verdict } from '../../core/v2/verdict.js'
import { v2TestContext } from './helpers.js'

describe('T13 no silent loosen on provider change', () => {
  it('keeps Tier0 high-stakes path ask with deterministic judge', async () => {
    const context = v2TestContext({ judge: createDeterministicJudgeStub() })
    const result = await verdict('rm -rf .git', context)
    expect(result.permission).toBe('ask')
    expect(result.reason).toBe('high_stakes_path')
  })

  it('falls back to ask when openai-compatible scrub fails', async () => {
    const config = normalizeConfig({
      ...DEFAULT_CONFIG_V4,
      judge: {
        provider: 'openai-compatible',
        model: 'composer-2.5',
        timeoutMs: 1000,
        endpoint: 'https://api.example.com/v1',
        keepAlive: null,
      },
    })
    const judge = createOpenAiCompatibleJudge({
      endpoint: 'https://api.example.com/v1',
      modelRequested: 'composer-2.5',
      modelResolved: 'composer-2.5',
      timeoutMs: 1000,
      apiKey: 'test',
      sensitivePaths: config.classifier.sensitivePaths,
      scrubOptions: config.redaction,
      fetchImpl: async () => new Response('{}', { status: 200 }),
    })
    const context = v2TestContext({ judge })
    const result = await verdict('curl https://example.com/api', context)
    expect(result.permission).toBe('ask')
  })
})
