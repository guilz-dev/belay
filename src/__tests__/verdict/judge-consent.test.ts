import { describe, expect, it } from 'vitest'

import { DEFAULT_JUDGE_LOCAL_OLLAMA } from '../../core/config.js'
import {
  applyCloudConsent,
  hasValidCloudConsent,
  resolveJudgeUsePatch,
} from '../../core/judge-config.js'

describe("cloud consent boundaries (plan A')", () => {
  it('does not record consent from acceptCloud in non-interactive mode', () => {
    const { judge, warnings } = resolveJudgeUsePatch(DEFAULT_JUDGE_LOCAL_OLLAMA, {
      providerId: 'codex',
      endpoint: 'https://api.openai.com/v1',
      acceptCloud: true,
      interactiveTTY: false,
    })
    expect(judge.cloudConsent?.accepted).toBeUndefined()
    expect(warnings.some((w) => w.includes('non-interactive'))).toBe(true)
  })

  it('records consent from capability approval id without --accept-cloud', () => {
    const { judge } = resolveJudgeUsePatch(DEFAULT_JUDGE_LOCAL_OLLAMA, {
      providerId: 'codex',
      endpoint: 'https://api.openai.com/v1',
      cloudConsentApprovalId: 'approval-456',
      interactiveTTY: false,
    })
    expect(judge.cloudConsent?.accepted).toBe(true)
    expect(judge.cloudConsent?.by).toBe('capability-approval:approval-456')
  })

  it('records consent from capability approval id with --accept-cloud', () => {
    const { judge } = resolveJudgeUsePatch(DEFAULT_JUDGE_LOCAL_OLLAMA, {
      providerId: 'codex',
      endpoint: 'https://api.openai.com/v1',
      acceptCloud: true,
      cloudConsentApprovalId: 'approval-123',
      interactiveTTY: false,
    })
    expect(judge.cloudConsent?.accepted).toBe(true)
    expect(judge.cloudConsent?.by).toBe('capability-approval:approval-123')
    expect(judge.cloudConsent?.endpoint).toBe('https://api.openai.com/v1')
  })

  it('records consent from interactive TTY confirmation', () => {
    const { judge } = resolveJudgeUsePatch(DEFAULT_JUDGE_LOCAL_OLLAMA, {
      providerId: 'codex',
      endpoint: 'https://api.openai.com/v1',
      acceptCloud: true,
      interactiveTTY: true,
      interactiveConsentApproved: true,
    })
    expect(judge.cloudConsent?.accepted).toBe(true)
    expect(judge.cloudConsent?.by).toBe('tty')
  })

  it('invalidates consent when providerId changes', () => {
    const judge = applyCloudConsent(
      {
        provider: 'openai-compatible',
        providerId: 'codex',
        model: 'gpt-5.3-codex-high',
        endpoint: 'https://api.openai.com/v1',
        timeoutMs: 8000,
        keepAlive: null,
      },
      { by: 'tty' },
    )
    expect(hasValidCloudConsent(judge)).toBe(true)
    expect(
      hasValidCloudConsent({
        ...judge,
        providerId: 'claude',
        endpoint: 'https://api.openai.com/v1',
      }),
    ).toBe(false)
  })
})
