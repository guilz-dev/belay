import { describe, expect, it } from 'vitest'

import {
  buildApprovalRecordedMessage,
  buildReplayEnvelopeFields,
  buildReplayHint,
  buildRetryInstructionForConfig,
  canAutoReplay,
  replayPayloadHash,
  validateReplayEnvelope,
} from '../core/approval-replay.js'
import { DEFAULT_APPROVAL_CONFIG, DEFAULT_CONFIG_V4 } from '../core/config.js'

function shellApproval(overrides: Partial<ApprovalRecord> = {}): ApprovalRecord {
  return {
    approvalId: 'belay_test000001',
    kind: 'shell',
    fingerprint: 'fp-shell',
    repoRoot: '/repo',
    reason: 'tier1_catastrophic',
    summary: 'git push origin main',
    createdAt: '2026-01-01T00:00:00.000Z',
    expiresAt: '2026-01-01T01:00:00.000Z',
    input: 'git push origin main',
    inputKind: 'shell',
    cwd: '/repo',
    ...overrides,
  }
}

describe('approval-replay', () => {
  it('defaults to one_step with shell auto replay enabled', () => {
    expect(DEFAULT_CONFIG_V4.approval.flow).toBe('one_step')
    expect(DEFAULT_CONFIG_V4.approval.autoReplayScopes.shell).toBe(true)
    expect(canAutoReplay(DEFAULT_CONFIG_V4, 'shell', 'cursor')).toBe(true)
  })

  it('falls back to two_step instructions when configured', () => {
    const config = {
      ...DEFAULT_CONFIG_V4,
      approval: { ...DEFAULT_APPROVAL_CONFIG, flow: 'two_step' as const },
    }
    expect(buildRetryInstructionForConfig(config, '/belay-approve', 'belay_abc')).toContain(
      'retry the original action unchanged',
    )
  })

  it('builds shell replay envelope fields', () => {
    const fields = buildReplayEnvelopeFields({
      kind: 'shell',
      command: 'git push origin main',
      inputKind: 'shell',
      cwd: '/repo',
      fingerprint: 'fp-shell',
      repoRoot: '/repo',
    })
    expect(fields.input).toBe('git push origin main')
    expect(fields.cwd).toBe('/repo')
  })

  it('returns replay hint for one_step shell approvals', () => {
    const hint = buildReplayHint(DEFAULT_CONFIG_V4, shellApproval(), 'cursor')
    expect(hint).toMatchObject({
      kind: 'shell',
      input: 'git push origin main',
      autoReplay: true,
      fallbackToTwoStep: false,
    })
  })

  it('falls back to two_step for tool approvals by default', () => {
    const approval = shellApproval({
      kind: 'tool',
      inputKind: 'tool',
      input: 'Write',
      toolName: 'Write',
      payloadHash: 'abc',
    })
    const hint = buildReplayHint(DEFAULT_CONFIG_V4, approval, 'cursor')
    expect(hint?.autoReplay).toBe(false)
    expect(hint?.fallbackToTwoStep).toBe(true)
    expect(buildApprovalRecordedMessage(DEFAULT_CONFIG_V4, approval, 'cursor')).toContain(
      'Retry the original action once',
    )
  })

  it('rejects replay envelope mismatches fail-closed', () => {
    const approval = shellApproval({ cwd: '/repo' })
    expect(
      validateReplayEnvelope(approval, {
        kind: 'shell',
        cwd: '/other',
        fingerprint: 'fp-shell',
        repoRoot: '/repo',
        command: 'git push origin main',
      }),
    ).toBe(false)
  })

  it('allows legacy approvals without envelope fields', () => {
    const approval = shellApproval({ cwd: undefined })
    expect(
      validateReplayEnvelope(approval, {
        kind: 'shell',
        cwd: '/other',
        fingerprint: 'fp-shell',
        repoRoot: '/repo',
      }),
    ).toBe(true)
  })

  it('suppresses auto replay when signing is required', () => {
    const config = {
      ...DEFAULT_CONFIG_V4,
      approvalSigning: { required: true },
    }
    expect(canAutoReplay(config, 'shell', 'cursor')).toBe(false)
  })

  it('rejects tool replay when cwd differs', () => {
    const payload = { path: 'notes.txt', contents: 'x' }
    const approval = shellApproval({
      kind: 'tool',
      inputKind: 'tool',
      toolName: 'Write',
      payloadHash: replayPayloadHash('tool', payload, '/repo'),
      cwd: '/repo',
    })
    expect(
      validateReplayEnvelope(approval, {
        kind: 'tool',
        cwd: '/repo/subdir',
        toolName: 'Write',
        payload,
        fingerprint: approval.fingerprint,
        repoRoot: '/repo',
      }),
    ).toBe(false)
  })
})
