import { describe, expect, it, vi } from 'vitest'
import { DEFAULT_CONFIG_V4, normalizeConfig } from '../../core/config.js'
import { diagnoseJudge } from '../../core/judge-doctor.js'
import { createDeterministicJudgeStub } from '../../core/verdict/judge.js'
import * as judgeFactory from '../../core/verdict/judge-factory.js'

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
        providerId: 'codex',
        model: 'gpt-5.3-codex-high',
        timeoutMs: 8000,
        endpoint: 'https://api.example.com/v1',
        keepAlive: null,
        cloudConsent: {
          accepted: true,
          at: '2026-01-01T00:00:00.000Z',
          providerId: 'codex',
          endpoint: 'https://api.example.com/v1',
          by: 'test',
        },
      },
    })
    const report = await diagnoseJudge(config)
    expect(report.issues.some((issue) => issue.includes('API key'))).toBe(true)
    if (previousBelay) {
      process.env.BELAY_JUDGE_API_KEY = previousBelay
    }
    if (previousOpenai) {
      process.env.OPENAI_API_KEY = previousOpenai
    }
  })

  it('does not flag missing endpoint for cursor provider', async () => {
    const config = normalizeConfig({
      ...DEFAULT_CONFIG_V4,
      judge: {
        provider: 'openai-compatible',
        providerId: 'cursor',
        model: 'composer-2.5',
        timeoutMs: 8000,
        endpoint: null,
        keepAlive: null,
      },
    })
    const report = await diagnoseJudge(config)
    expect(report.issues.some((issue) => issue.includes('endpoint'))).toBe(false)
    expect(report.notes).toContain('Judge transport: cursor-acp')
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

  it('reports smoke probe failures as issues with recovery hints', async () => {
    const previousVitest = process.env.VITEST
    const previousVitestWorker = process.env.VITEST_WORKER_ID
    delete process.env.VITEST
    delete process.env.VITEST_WORKER_ID

    const judge = createDeterministicJudgeStub()
    vi.spyOn(judgeFactory, 'createJudgeFromConfig').mockReturnValue({
      ...judge,
      async evaluate() {
        judge.lastTrace = {
          provider: 'fallback',
          modelRequested: 'composer-2.5',
          modelResolved: 'composer-2.5',
          latencyMs: 1,
          judgeFallbackReason: 'cursor_cli_nonzero',
        }
        return {
          local_recoverable: false,
          destroys_history_or_secrets: false,
          reason: 'cursor_cli_nonzero',
        }
      },
      get lastTrace() {
        return judge.lastTrace
      },
    })

    const config = normalizeConfig({
      ...DEFAULT_CONFIG_V4,
      judge: {
        provider: 'openai-compatible',
        providerId: 'cursor',
        model: 'composer-2.5',
        timeoutMs: 8000,
        endpoint: null,
        keepAlive: null,
      },
    })

    try {
      const report = await diagnoseJudge(config, process.cwd(), { liveProbe: true })
      expect(
        report.issues.some(
          (issue) => issue.includes('cursor_cli_nonzero') && issue.includes('agent login'),
        ),
      ).toBe(true)
    } finally {
      vi.restoreAllMocks()
      if (previousVitest) {
        process.env.VITEST = previousVitest
      }
      if (previousVitestWorker) {
        process.env.VITEST_WORKER_ID = previousVitestWorker
      }
    }
  })

  it('passes configured judge timeout to CLI smoke probe without a 5s cap', async () => {
    const previousVitest = process.env.VITEST
    const previousVitestWorker = process.env.VITEST_WORKER_ID
    delete process.env.VITEST
    delete process.env.VITEST_WORKER_ID

    const judge = createDeterministicJudgeStub()
    const createSpy = vi.spyOn(judgeFactory, 'createJudgeFromConfig').mockReturnValue({
      ...judge,
      async evaluate() {
        judge.lastTrace = {
          provider: 'openai-compatible',
          modelRequested: 'composer-2.5',
          modelResolved: 'composer-2.5',
          latencyMs: 1,
        }
        return {
          local_recoverable: true,
          destroys_history_or_secrets: false,
          reason: 'doctor_smoke',
        }
      },
      get lastTrace() {
        return judge.lastTrace
      },
    })

    const config = normalizeConfig({
      ...DEFAULT_CONFIG_V4,
      judge: {
        provider: 'openai-compatible',
        providerId: 'cursor',
        model: 'composer-2.5',
        timeoutMs: 25000,
        endpoint: null,
        keepAlive: null,
      },
    })

    try {
      const report = await diagnoseJudge(config, process.cwd(), { liveProbe: true })
      expect(createSpy).toHaveBeenCalled()
      const smokeConfig = createSpy.mock.calls[0]?.[0]
      expect(smokeConfig?.judge.timeoutMs).toBe(25000)
      expect(report.notes.some((note) => note.includes('smoke probe succeeded'))).toBe(true)
    } finally {
      vi.restoreAllMocks()
      if (previousVitest) {
        process.env.VITEST = previousVitest
      }
      if (previousVitestWorker) {
        process.env.VITEST_WORKER_ID = previousVitestWorker
      }
    }
  })
})
