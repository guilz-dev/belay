import { describe, expect, it } from 'vitest'

import { buildCliInvocation } from '../../core/verdict/judge-cli.js'
import { DEFAULT_JUDGE_SESSION_CONFIG } from '../../core/verdict/judge-runtime-config.js'
import {
  JudgeSessionBroker,
  resetJudgeSessionBrokersForTests,
} from '../../core/verdict/judge-session-broker.js'

const SAFE_JSON = JSON.stringify({
  local_recoverable: true,
  destroys_history_or_secrets: false,
  reason: 'safe',
  chat_id: 'chat-123',
})

const KEY_PARTS = {
  providerId: 'cursor' as const,
  model: 'composer-2.5',
  repoRoot: '/repo/a',
  judgeMode: 'audit',
  cliVersion: '1.0.0',
}

describe('judge-session-broker', () => {
  it('serializes concurrent evaluates with distinct results per prompt', async () => {
    resetJudgeSessionBrokersForTests()
    let calls = 0
    let activeCalls = 0
    let maxActiveCalls = 0
    const broker = new JudgeSessionBroker({
      config: { ...DEFAULT_JUDGE_SESSION_CONFIG, enabled: true },
      runCommand: async (invocation) => {
        calls += 1
        activeCalls += 1
        maxActiveCalls = Math.max(maxActiveCalls, activeCalls)
        await new Promise((resolve) => setTimeout(resolve, 20))
        const prompt = invocation.args[invocation.args.length - 1] ?? ''
        const result = JSON.stringify({
          local_recoverable: prompt.startsWith('allow:'),
          destroys_history_or_secrets: false,
          reason: prompt.startsWith('allow:') ? 'safe' : 'unsafe',
          chat_id: 'chat-123',
        })
        activeCalls -= 1
        return result
      },
    })

    const invocationA = buildCliInvocation('cursor', 'allow:one', 'composer-2.5')
    const invocationB = buildCliInvocation('cursor', 'deny:two', 'composer-2.5')

    const [first, second] = await Promise.all([
      broker.evaluate({ keyParts: KEY_PARTS, invocation: invocationA, promptBytes: 10 }, 1_000),
      broker.evaluate(
        {
          keyParts: { ...KEY_PARTS, judgeMode: 'enforce' },
          invocation: invocationB,
          promptBytes: 10,
        },
        1_000,
      ),
    ])

    expect(calls).toBe(2)
    expect(maxActiveCalls).toBe(1)
    expect(JSON.parse(first.raw).local_recoverable).toBe(true)
    expect(JSON.parse(second.raw).local_recoverable).toBe(false)
  })

  it('captures provider resume id for cursor', async () => {
    const broker = new JudgeSessionBroker({
      config: { ...DEFAULT_JUDGE_SESSION_CONFIG, enabled: true },
      runCommand: async () => SAFE_JSON,
    })
    const invocation = buildCliInvocation('cursor', 'prompt', 'composer-2.5')
    const first = await broker.evaluate({ keyParts: KEY_PARTS, invocation, promptBytes: 10 }, 1_000)
    expect(first.providerResumeId).toBe('chat-123')

    const second = await broker.evaluate(
      { keyParts: KEY_PARTS, invocation, promptBytes: 10 },
      1_000,
    )
    expect(second.reused).toBe(true)
  })
})
