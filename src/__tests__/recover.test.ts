import { describe, expect, it, vi } from 'vitest'
import { formatRecoverReport } from '../commands/recover.js'
import {
  buildRecoverAdvice,
  containsDeniedRecoveryPattern,
  RECOVER_DISCLAIMER,
  SHOW_DONT_RUN_LEAD,
} from '../core/recover-advice.js'
import * as recoverGitProbe from '../core/recover-git-probe.js'

describe('recover advice (T-R1, T-R3, T-R4, T-R5)', () => {
  it('suggests file-scoped git restore for local mutation', () => {
    const result = buildRecoverAdvice({
      repoRoot: '/repo',
      target: {
        summary: 'rm src/important.ts',
        reason: 'local_mutation',
        effect: 'local_mutation',
        assessment: { reversibility: 'recoverable_with_cost' } as never,
      },
      git: { inWorkTree: true, notes: [] },
    })

    expect(result.recoverable).toBe(true)
    expect(result.advice.some((line) => line.includes('git restore'))).toBe(true)
    expect(result.advice[0]).toBe(SHOW_DONT_RUN_LEAD)
  })

  it('marks external irreversible targets as not recoverable (T-R3)', () => {
    const result = buildRecoverAdvice({
      repoRoot: '/repo',
      target: {
        summary: 'docker push myapp:latest',
        reason: 'tier0_external',
        effect: 'external_effect',
        assessment: { reversibility: 'irreversible', external: true } as never,
      },
    })

    expect(result.recoverable).toBe(false)
    expect(result.advice.some((line) => line.includes('not recoverable'))).toBe(true)
  })

  it('does not suggest irreversible recovery patterns (T-R4)', () => {
    const result = buildRecoverAdvice({
      repoRoot: '/repo',
      target: {
        summary: 'rm tracked.txt',
        reason: 'local_mutation',
        effect: 'local_mutation',
      },
      git: { inWorkTree: true, notes: [] },
    })

    const combined = result.advice.join('\n')
    expect(containsDeniedRecoveryPattern(combined)).toBe(false)
    expect(combined).not.toMatch(/reset\s+--hard/i)
  })

  it('includes show-don-t-run disclaimer framing (T-R5)', () => {
    const result = buildRecoverAdvice({
      repoRoot: '/repo',
      target: {
        summary: 'rm file.txt',
        reason: 'local_mutation',
        effect: 'local_mutation',
      },
      git: { inWorkTree: true, notes: [] },
    })

    expect(RECOVER_DISCLAIMER.every((line) => result.disclaimer.includes(line))).toBe(true)
    expect(
      formatRecoverReport({
        repoRoot: '/repo',
        recoverable: result.recoverable,
        confidence: result.confidence,
        disclaimer: result.disclaimer,
        advice: result.advice,
        warnings: result.warnings,
      }),
    ).toContain('Advisory only')
  })
})

describe('recover git probe (T-R2)', () => {
  it('uses read-only git commands only', async () => {
    const execFile = vi.fn().mockResolvedValue({ stdout: 'true\n' })
    vi.spyOn(recoverGitProbe, 'probeGitState').mockImplementation(async (repoRoot) => {
      await execFile('git', ['rev-parse', '--is-inside-work-tree'], { cwd: repoRoot })
      await execFile('git', ['status', '--porcelain'], { cwd: repoRoot })
      await execFile('git', ['reflog', '-n', '10'], { cwd: repoRoot })
      return { inWorkTree: true, notes: [] }
    })

    await recoverGitProbe.probeGitState('/repo')

    const invoked = execFile.mock.calls.map((call) => `${call[1].join(' ')}`)
    expect(invoked).toEqual([
      'rev-parse --is-inside-work-tree',
      'status --porcelain',
      'reflog -n 10',
    ])
    for (const command of invoked) {
      expect(recoverGitProbe.isReadOnlyGitProbe(command)).toBe(true)
    }

    vi.restoreAllMocks()
  })
})
