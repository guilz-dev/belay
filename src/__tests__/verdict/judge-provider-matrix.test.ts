import { describe, expect, it } from 'vitest'

import { buildCliInvocation } from '../../core/verdict/judge-cli.js'
import {
  assertReadOnlyInvocationArgs,
  JUDGE_PROVIDER_SESSION_MATRIX,
  providerSupportsSession,
} from '../../core/verdict/judge-provider-matrix.js'

describe('judge-provider-matrix', () => {
  it('enables cursor in allowlist only when capability supports session', () => {
    expect(providerSupportsSession('cursor', ['cursor'])).toBe(true)
  })

  it('codex remains disabled until capability matrix opts in', () => {
    expect(providerSupportsSession('codex', ['codex'])).toBe(false)
    expect(providerSupportsSession('claude', ['claude'])).toBe(false)
  })

  it('rejects unsafe options for each provider', () => {
    for (const providerId of ['cursor', 'codex', 'claude'] as const) {
      const unsafe = JUDGE_PROVIDER_SESSION_MATRIX[providerId].rejectedUnsafeOptions[0]
      if (!unsafe) {
        continue
      }
      const invocation = buildCliInvocation(providerId, 'prompt', 'model')
      const argsWithUnsafe = [...invocation.args, unsafe]
      expect(assertReadOnlyInvocationArgs(providerId, argsWithUnsafe).ok).toBe(false)
    }
  })

  it('accepts canonical read-only cursor invocation', () => {
    const invocation = buildCliInvocation('cursor', 'prompt', 'composer-2.5')
    expect(assertReadOnlyInvocationArgs('cursor', invocation.args).ok).toBe(true)
  })
})
