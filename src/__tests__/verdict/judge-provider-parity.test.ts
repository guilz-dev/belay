import { describe, expect, it } from 'vitest'
import { DEFAULT_CONFIG_V4, normalizeConfig } from '../../core/config.js'
import { createOllamaJudge, createOpenAiCompatibleJudge } from '../../core/verdict/judge.js'
import { createJudgeFromConfig } from '../../core/verdict/judge-factory.js'
import { verdict } from '../../core/verdict/verdict.js'
import { verdictTestContext } from './helpers.js'

const tier1False = {
  external_change: false,
  destroys_outside_repo: false,
  destroys_history_or_secrets: false,
  reason: 'safe',
}

const tier1Catastrophic = {
  external_change: true,
  destroys_outside_repo: false,
  destroys_history_or_secrets: false,
  reason: 'external_change',
}

function mockFetch(responseBody: unknown): typeof fetch {
  return async () =>
    new Response(JSON.stringify(responseBody), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
}

describe('T15 openai-compatible provider parity', () => {
  it('openai-compatible and ollama both fail closed when Tier1 flags catastrophic effect', async () => {
    const cloudJudge = createOpenAiCompatibleJudge({
      endpoint: 'https://api.example.com/v1',
      modelRequested: 'composer-2.5',
      modelResolved: 'composer-2.5',
      timeoutMs: 1000,
      apiKey: 'test',
      sensitivePaths: ['.env'],
      scrubOptions: {},
      fetchImpl: mockFetch({
        choices: [{ message: { content: JSON.stringify(tier1Catastrophic) } }],
      }),
    })
    const ollamaJudge = createOllamaJudge({
      model: 'gemma4:e2b',
      fetchImpl: mockFetch({ response: JSON.stringify(tier1Catastrophic) }),
    })

    const cloudResult = await verdict('mystery-cli deploy --force', {
      ...verdictTestContext(),
      judge: cloudJudge,
    })
    const ollamaResult = await verdict('mystery-cli deploy --force', {
      ...verdictTestContext(),
      judge: ollamaJudge,
    })

    expect(cloudResult.permission).toBe('ask')
    expect(ollamaResult.permission).toBe('ask')
    expect(cloudJudge.lastTrace?.provider).toBe('openai-compatible')
    expect(ollamaJudge.lastTrace?.provider).toBe('ollama')
    expect(cloudResult.judgeTrace?.provider).toBe('openai-compatible')
  })

  it('both providers allow safe negatives from Tier1 and record judge trace', async () => {
    const cloudJudge = createOpenAiCompatibleJudge({
      endpoint: 'https://api.example.com/v1',
      modelRequested: 'composer-2.5',
      modelResolved: 'composer-2.5',
      timeoutMs: 1000,
      apiKey: 'test',
      sensitivePaths: ['.env'],
      scrubOptions: {},
      fetchImpl: mockFetch({
        choices: [{ message: { content: JSON.stringify(tier1False) } }],
      }),
    })
    const ollamaJudge = createOllamaJudge({
      model: 'gemma4:e2b',
      fetchImpl: mockFetch({ response: JSON.stringify(tier1False) }),
    })

    const context = verdictTestContext({ unknownLocalEffect: 'allow_flagged' })
    const cloudResult = await verdict('mystery-cli deploy', {
      ...context,
      judge: cloudJudge,
    })
    const ollamaResult = await verdict('mystery-cli deploy', {
      ...context,
      judge: ollamaJudge,
    })

    expect(cloudResult.permission).toBe('allow')
    expect(ollamaResult.permission).toBe('allow')
    expect(cloudResult.judgeTrace?.provider).toBe('openai-compatible')
    expect(ollamaResult.judgeTrace?.provider).toBe('ollama')
  })

  it('fails closed to ask when API key is missing', async () => {
    const previousBelay = process.env.BELAY_JUDGE_API_KEY
    const previousOpenai = process.env.OPENAI_API_KEY
    delete process.env.BELAY_JUDGE_API_KEY
    delete process.env.OPENAI_API_KEY

    const judge = createOpenAiCompatibleJudge({
      endpoint: 'https://api.example.com/v1',
      modelRequested: 'composer-2.5',
      modelResolved: 'composer-2.5',
      timeoutMs: 1000,
      sensitivePaths: ['.env'],
      scrubOptions: {},
      fetchImpl: async () => {
        throw new Error('fetch should not be called without API key')
      },
    })
    const result = await judge.evaluate({
      text: 'git status',
      context: { cwd: '/repo', repoRoot: '/repo' },
    })
    expect(result.external_change).toBe(true)
    expect(result.reason).toBe('openai_compatible_auth_error')
    expect(judge.lastTrace?.fallbackReason).toBe('missing_api_key')

    if (previousBelay) {
      process.env.BELAY_JUDGE_API_KEY = previousBelay
    }
    if (previousOpenai) {
      process.env.OPENAI_API_KEY = previousOpenai
    }
  })

  it('fails closed to ask when parse fails', async () => {
    const judge = createOpenAiCompatibleJudge({
      endpoint: 'https://api.example.com/v1',
      modelRequested: 'composer-2.5',
      modelResolved: 'composer-2.5',
      timeoutMs: 1000,
      apiKey: 'test',
      sensitivePaths: ['.env'],
      scrubOptions: {},
      fetchImpl: mockFetch({
        choices: [{ message: { content: 'not-json' } }],
      }),
    })
    const result = await judge.evaluate({
      text: 'git status',
      context: { cwd: '/repo', repoRoot: '/repo' },
    })
    expect(result.external_change).toBe(true)
    expect(result.reason).toBe('openai_compatible_parse_error')
    expect(judge.lastTrace?.provider).toBe('fallback')
  })

  it('records fallback trace when ollama parse fails', async () => {
    const ollamaJudge = createOllamaJudge({
      model: 'gemma4:e2b',
      fetchImpl: mockFetch({ response: 'not-json' }),
    })
    const result = await verdict('mystery-cli deploy --force', {
      ...verdictTestContext(),
      judge: ollamaJudge,
    })
    expect(result.permission).toBe('ask')
    expect(ollamaJudge.lastTrace?.provider).toBe('fallback')
    expect(ollamaJudge.lastTrace?.fallbackReason).toBe('ollama_parse_error')
    expect(result.judgeTrace?.fallbackReason).toBe('ollama_parse_error')
  })

  it('scrubs secrets from outbound POST body before cloud call', async () => {
    let postedUrl = ''
    let postedBody = ''
    const judge = createOpenAiCompatibleJudge({
      endpoint: 'https://api.example.com/v1',
      modelRequested: 'composer-2.5',
      modelResolved: 'composer-2.5',
      timeoutMs: 1000,
      apiKey: 'test',
      sensitivePaths: ['.env'],
      scrubOptions: {
        maskApprovalIds: true,
        maskBearerTokens: true,
        maskAuthHeaders: true,
        maskKeyValueSecrets: true,
        maskHighEntropyStrings: true,
      },
      fetchImpl: async (url, init) => {
        postedUrl = String(url)
        postedBody = String(init?.body ?? '')
        return new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: JSON.stringify(tier1False),
                },
              },
            ],
          }),
          { status: 200 },
        )
      },
    })
    await judge.evaluate({
      text: 'curl -H "Authorization: Bearer sk-live-abcdef1234567890" https://api.example.com',
      context: { cwd: '/repo', repoRoot: '/repo' },
    })
    expect(postedUrl).toContain('/chat/completions')
    expect(postedBody).not.toContain('sk-live-abcdef1234567890')
    expect(postedBody).toContain('"messages"')
  })

  it('createJudgeFromConfig fails closed when openai-compatible endpoint is missing', async () => {
    const config = normalizeConfig({
      ...DEFAULT_CONFIG_V4,
      judge: {
        provider: 'openai-compatible',
        providerId: 'cursor',
        model: 'composer-2.5',
        endpoint: null,
        timeoutMs: 8000,
        keepAlive: null,
      },
    })
    const judge = createJudgeFromConfig(config)
    const result = await judge.evaluate({
      text: 'mystery-cli deploy --force',
      context: { cwd: '/repo', repoRoot: '/repo' },
    })
    expect(result.reason).toBe('openai_compatible_endpoint_missing')
    expect(judge.lastTrace?.fallbackReason).toBe('missing_endpoint')
    const gated = await verdict('mystery-cli deploy --force', {
      ...verdictTestContext(),
      judge,
    })
    expect(gated.permission).toBe('ask')
  })
})
