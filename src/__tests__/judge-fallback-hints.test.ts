import { describe, expect, it } from 'vitest'
import {
  extractJudgeFallbackReason,
  formatJudgeInfrastructureDenyMessage,
  formatJudgeRecoveryHint,
  inferProviderIdFromFallbackReason,
  isJudgeInfrastructureFailure,
} from '../core/judge-fallback-hints.js'
import type { ClassifyResult } from '../core/types.js'

function classifyResult(
  partial: Partial<ClassifyResult> & Pick<ClassifyResult, 'assessment'>,
): ClassifyResult {
  return {
    verdict: 'deny_pending_approval',
    reason: 'tier1_catastrophic',
    fingerprint: 'test-fingerprint',
    ...partial,
  }
}

describe('judge-fallback-hints', () => {
  it('detects infrastructure failure from judge fallback axes', () => {
    const result = classifyResult({
      assessment: { reversibility: 'reversible', external: false, blastRadius: 'none', confidence: 0.7, signals: ['tier1_catastrophic', 'cursor_cli_nonzero'] },
      axes: {
        location: 'repo_local',
        opacity: 'transparent',
        effect: 'unknown',
        confidence: 'llm',
        would: 'ask',
        by: 'verdict',
        judgeProvider: 'fallback',
        judgeFallbackReason: 'cursor_cli_nonzero',
      },
    })

    expect(isJudgeInfrastructureFailure(result)).toBe(true)
    expect(extractJudgeFallbackReason(result)).toBe('cursor_cli_nonzero')
    expect(inferProviderIdFromFallbackReason('cursor_cli_nonzero')).toBe('cursor')
  })

  it('does not treat genuine high-risk verdicts as infrastructure failure', () => {
    const result = classifyResult({
      reason: 'tier1_catastrophic',
      assessment: {
        reversibility: 'irreversible',
        external: true,
        blastRadius: 'repo',
        confidence: 0.9,
        signals: ['tier1_catastrophic', 'destroys_history_or_secrets'],
      },
      axes: {
        location: 'repo_local',
        opacity: 'transparent',
        effect: 'remote_mutation',
        confidence: 'llm',
        would: 'ask',
        by: 'verdict',
        judgeProvider: 'openai-compatible',
      },
    })

    expect(isJudgeInfrastructureFailure(result)).toBe(false)
  })

  it('formats cursor recovery hints', () => {
    expect(formatJudgeRecoveryHint('cursor', 'cursor_cli_nonzero')).toBe(
      'Judge CLI is not authenticated. Run: agent login',
    )
    expect(formatJudgeRecoveryHint('cursor', 'eval_timeout')).toBe(
      'Judge timed out. Check network or increase judge.timeoutMs',
    )
  })

  it('formats infrastructure deny messages without approval ids', () => {
    const message = formatJudgeInfrastructureDenyMessage({
      providerId: 'cursor',
      fallbackReason: 'cursor_cli_nonzero',
      command: 'node --version',
    })

    expect(message.user_message).toContain('cursor_cli_nonzero')
    expect(message.user_message).toContain('agent login')
    expect(message.user_message).toContain('belay explain --command "node --version"')
    expect(message.agent_message).toContain('Tier1 judge transport failed')
    expect(message.user_message).not.toContain('Approval ID')
  })
})
