import { describe, expect, it } from 'vitest'
import { DEFAULT_CONFIG_V4, normalizeConfig } from '../../core/config.js'
import {
  createDeterministicJudgeStub,
  createOpenAiCompatibleJudge,
  tier1RequiresAsk,
} from '../../core/verdict/judge.js'
import { verdict } from '../../core/verdict/verdict.js'
import { verdictTestContext } from './helpers.js'

describe('T13 no silent loosen on provider change', () => {
  it('tier1RequiresAsk treats destroys_history_or_secrets as ask', () => {
    expect(
      tier1RequiresAsk({
        local_recoverable: true,
        destroys_outside_repo: false,
        destroys_history_or_secrets: true,
        reason: 'authorized_keys',
      }),
    ).toBe(true)
  })

  it('routes shell redirects outside repo through Tier1', async () => {
    const context = verdictTestContext({ judge: createDeterministicJudgeStub() })
    const result = await verdict('echo hi > ../outside.txt', context)
    expect(result.permission).toBe('allow')
    expect(result.reason).toBe('repo_outside_local_mutation')
  })

  it('keeps Tier0 high-stakes path ask with deterministic judge', async () => {
    const context = verdictTestContext({ judge: createDeterministicJudgeStub() })
    const result = await verdict('rm -rf .git', context)
    expect(result.permission).toBe('ask')
    expect(result.reason).toBe('high_stakes_path')
  })

  it('falls back to ask when openai-compatible scrub fails on ambiguous egress', async () => {
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
    const context = verdictTestContext({ judge })
    const result = await verdict('aws s3 mb s3://new-bucket', context)
    expect(result.permission).toBe('ask')
  })
})
