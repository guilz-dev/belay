import { describe, expect, it } from 'vitest'
import { createCursorJudge, createOllamaJudge } from '../../core/v2/judge.js'
import { verdict } from '../../core/v2/verdict.js'
import { v2TestContext } from './helpers.js'

const tier1False = {
  external_change: false,
  destroys_outside_repo: false,
  destroys_history_or_secrets: false,
  reason: 'safe',
}

function mockFetch(responseBody: unknown): typeof fetch {
  return async () =>
    new Response(JSON.stringify(responseBody), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
}

describe('T10 provider parity (pinned models)', () => {
  it('cursor and ollama both fail closed on catastrophic curl mutation', async () => {
    const catastrophic = {
      external_change: true,
      destroys_outside_repo: false,
      destroys_history_or_secrets: false,
      reason: 'external_change',
    }
    const cursorJudge = createCursorJudge({
      modelRequested: 'composer-2.5',
      modelResolved: 'composer-2.5',
      timeoutMs: 1000,
      apiKey: 'test',
      sensitivePaths: ['.env'],
      scrubOptions: {},
      fetchImpl: mockFetch({
        choices: [{ message: { content: JSON.stringify(catastrophic) } }],
      }),
    })
    const ollamaJudge = createOllamaJudge({
      model: 'gemma4:e2b',
      fetchImpl: mockFetch({ response: JSON.stringify(catastrophic) }),
    })

    const cursorResult = await verdict('curl -X DELETE https://api.example.com/db', {
      ...v2TestContext(),
      judge: cursorJudge,
    })
    const ollamaResult = await verdict('curl -X DELETE https://api.example.com/db', {
      ...v2TestContext(),
      judge: ollamaJudge,
    })

    expect(cursorResult.permission).toBe('ask')
    expect(ollamaResult.permission).toBe('ask')
  })

  it('both providers allow safe negatives from Tier1', async () => {
    const cursorJudge = createCursorJudge({
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

    const context = v2TestContext({ unknownLocalEffect: 'allow_flagged' })
    const cursorResult = await verdict('mystery-cli deploy', {
      ...context,
      judge: cursorJudge,
    })
    const ollamaResult = await verdict('mystery-cli deploy', {
      ...context,
      judge: ollamaJudge,
    })

    expect(cursorResult.permission).toBe('allow')
    expect(ollamaResult.permission).toBe('allow')
  })
})
