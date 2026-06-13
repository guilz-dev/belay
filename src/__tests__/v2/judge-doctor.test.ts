import { describe, expect, it } from 'vitest'
import { DEFAULT_CONFIG_V4, normalizeConfig } from '../../core/config.js'
import { diagnoseJudge } from '../../core/judge-doctor.js'

describe('T12 doctor judge matrix', () => {
  it('warns when policy.modelAssist is enabled', async () => {
    const config = normalizeConfig({
      ...DEFAULT_CONFIG_V4,
      policy: {
        ...DEFAULT_CONFIG_V4.policy,
        modelAssist: { enabled: true, timeoutMs: 3000 },
      },
    })
    const report = await diagnoseJudge(config)
    expect(report.warnings.some((warning) => warning.includes('modelAssist'))).toBe(true)
  })

  it('flags missing API key for openai-compatible provider', async () => {
    const previousBelay = process.env.BELAY_JUDGE_API_KEY
    const previousOpenai = process.env.OPENAI_API_KEY
    delete process.env.BELAY_JUDGE_API_KEY
    delete process.env.OPENAI_API_KEY
    const config = normalizeConfig({
      ...DEFAULT_CONFIG_V4,
      judge: {
        provider: 'openai-compatible',
        model: 'auto',
        timeoutMs: 8000,
        endpoint: 'https://api.example.com/v1',
        keepAlive: null,
      },
    })
    const report = await diagnoseJudge(config)
    expect(
      report.issues.some(
        (issue) => issue.includes('BELAY_JUDGE_API_KEY') || issue.includes('OPENAI_API_KEY'),
      ),
    ).toBe(true)
    if (previousBelay) {
      process.env.BELAY_JUDGE_API_KEY = previousBelay
    }
    if (previousOpenai) {
      process.env.OPENAI_API_KEY = previousOpenai
    }
  })

  it('flags missing endpoint for openai-compatible provider', async () => {
    const config = normalizeConfig({
      ...DEFAULT_CONFIG_V4,
      judge: {
        provider: 'openai-compatible',
        model: 'auto',
        timeoutMs: 8000,
        endpoint: null,
        keepAlive: null,
      },
    })
    const report = await diagnoseJudge(config)
    expect(report.issues.some((issue) => issue.includes('endpoint'))).toBe(true)
  })

  it('flags unreachable ollama endpoint', async () => {
    const config = normalizeConfig({
      ...DEFAULT_CONFIG_V4,
      judge: {
        provider: 'ollama',
        model: 'gemma4:e2b',
        endpoint: 'http://127.0.0.1:1',
        timeoutMs: 1000,
        keepAlive: '30m',
      },
    })
    const report = await diagnoseJudge(config)
    expect(report.issues.some((issue) => issue.toLowerCase().includes('ollama'))).toBe(true)
  })
})
