import { describe, expect, it } from 'vitest'
import { resolveJudgeSmokeProbeTimeoutMs } from '../../core/verdict/judge-runtime-config.js'

describe('judge-runtime-config', () => {
  it('resolveJudgeSmokeProbeTimeoutMs returns configured timeout unchanged', () => {
    expect(resolveJudgeSmokeProbeTimeoutMs(8000)).toBe(8000)
    expect(resolveJudgeSmokeProbeTimeoutMs(25000)).toBe(25000)
  })
})
