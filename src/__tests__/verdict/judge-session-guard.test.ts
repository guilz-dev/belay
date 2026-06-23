import { describe, expect, it } from 'vitest'
import { DEFAULT_JUDGE_SESSION_CONFIG } from '../../core/verdict/judge-runtime-config.js'
import {
  buildJudgeSessionKey,
  evaluateSessionReuse,
  exceedsPromptBudget,
  transportFallbackToFailClosedReason,
} from '../../core/verdict/judge-session-guard.js'

const KEY_PARTS = {
  providerId: 'cursor' as const,
  model: 'composer-2.5',
  repoRoot: '/repo/a',
  judgeMode: 'audit',
  cliVersion: '1.0.0',
}

describe('judge-session-guard', () => {
  it('builds stable session keys with cli version', () => {
    expect(buildJudgeSessionKey(KEY_PARTS)).toBe('cursor:composer-2.5:/repo/a:audit:1.0.0')
  })

  it('rejects reuse when provider allowlist excludes provider', () => {
    const decision = evaluateSessionReuse(null, KEY_PARTS, null, {
      ...DEFAULT_JUDGE_SESSION_CONFIG,
      enabled: true,
      providerAllowlist: ['codex'],
    })
    expect(decision.canReuse).toBe(false)
    expect(decision.resetReason).toBe('provider_not_allowlisted')
  })

  it('forces reset when max turns exceeded', () => {
    const now = Date.now()
    const decision = evaluateSessionReuse(
      KEY_PARTS,
      KEY_PARTS,
      {
        turnCount: DEFAULT_JUDGE_SESSION_CONFIG.maxTurns,
        createdAtMs: now - 1_000,
        lastUsedAtMs: now - 1_000,
        promptBytes: 0,
      },
      { ...DEFAULT_JUDGE_SESSION_CONFIG, enabled: true },
      now,
    )
    expect(decision.canReuse).toBe(false)
    expect(decision.resetReason).toBe('max_turns_exceeded')
  })

  it('forces reset on cli version mismatch', () => {
    const decision = evaluateSessionReuse(
      KEY_PARTS,
      { ...KEY_PARTS, cliVersion: '2.0.0' },
      {
        turnCount: 1,
        createdAtMs: Date.now(),
        lastUsedAtMs: Date.now(),
        promptBytes: 0,
      },
      { ...DEFAULT_JUDGE_SESSION_CONFIG, enabled: true },
    )
    expect(decision.canReuse).toBe(false)
    expect(decision.resetReason).toBe('cli_version_mismatch')
  })

  it('detects prompt byte budget exhaustion', () => {
    expect(
      exceedsPromptBudget(
        DEFAULT_JUDGE_SESSION_CONFIG.maxPromptBytes + 1,
        DEFAULT_JUDGE_SESSION_CONFIG,
      ),
    ).toBe(true)
    expect(
      exceedsPromptBudget(100, DEFAULT_JUDGE_SESSION_CONFIG, {
        turnCount: 1,
        createdAtMs: Date.now(),
        lastUsedAtMs: Date.now(),
        promptBytes: DEFAULT_JUDGE_SESSION_CONFIG.maxPromptBytes,
      }),
    ).toBe(true)
  })

  it('forces reset when cumulative prompt bytes would exceed budget', () => {
    const decision = evaluateSessionReuse(
      KEY_PARTS,
      KEY_PARTS,
      {
        turnCount: 1,
        createdAtMs: Date.now(),
        lastUsedAtMs: Date.now(),
        promptBytes: DEFAULT_JUDGE_SESSION_CONFIG.maxPromptBytes,
      },
      { ...DEFAULT_JUDGE_SESSION_CONFIG, enabled: true },
      Date.now(),
      1,
    )
    expect(decision.canReuse).toBe(false)
    expect(decision.resetReason).toBe('max_prompt_bytes_exceeded')
  })

  it('rejects reuse across repo boundaries', () => {
    const decision = evaluateSessionReuse(
      KEY_PARTS,
      { ...KEY_PARTS, repoRoot: '/repo/b' },
      {
        turnCount: 1,
        createdAtMs: Date.now(),
        lastUsedAtMs: Date.now(),
        promptBytes: 0,
      },
      { ...DEFAULT_JUDGE_SESSION_CONFIG, enabled: true },
    )
    expect(decision.canReuse).toBe(false)
    expect(decision.resetReason).toBe('repo_mismatch')
  })

  it('maps transport fallback reasons to fail-closed verdict reasons', () => {
    expect(transportFallbackToFailClosedReason('cursor', 'eval_timeout')).toBe(
      'cursor_cli_unavailable',
    )
    expect(transportFallbackToFailClosedReason('cursor', 'connect_timeout')).toBe(
      'cursor_cli_unavailable',
    )
    expect(transportFallbackToFailClosedReason('cursor', 'non_json_response')).toBe(
      'cursor_cli_parse_error',
    )
    expect(transportFallbackToFailClosedReason('cursor', 'parse_error')).toBe(
      'cursor_cli_parse_error',
    )
    expect(transportFallbackToFailClosedReason('cursor', 'cursor_cli_unavailable')).toBe(
      'cursor_cli_unavailable',
    )
  })
})
