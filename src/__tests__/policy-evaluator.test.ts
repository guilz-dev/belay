import { describe, expect, it } from 'vitest'

import { DEFAULT_CONFIDENCE_THRESHOLDS } from '../core/config.js'
import { evaluatePolicyRules } from '../core/policy/evaluator.js'
import { analyzeShellSegment } from '../core/shell-analysis.js'
import { tokenizeShell } from '../core/shell-tokenizer.js'

const repoRoot = '/workspace/project'
const cwd = '/workspace/project/src'

function evaluate(command: string) {
  const tokens = tokenizeShell(command)
  const attributes = analyzeShellSegment({
    segmentTokens: tokens,
    cwd,
    repoRoot,
    normalizedCommand: command,
    cwdRelative: 'src',
    options: {
      unknownLocalEffect: 'deny',
      unparseableShell: 'deny',
      controlPlaneDir: '/home/user/.config/agent-belay',
    },
  })
  return evaluatePolicyRules(attributes, {
    unknownLocalEffect: 'deny',
    unparseableShell: 'deny',
    confidenceThresholds: DEFAULT_CONFIDENCE_THRESHOLDS,
  })
}

describe('policy evaluator', () => {
  it('denies protected artifact mutations before custom allow', () => {
    const result = evaluate('tee /home/user/.config/agent-belay/pending-approvals.json')
    expect(result.verdict).toBe('deny_pending_approval')
    expect(result.reason).toBe('control_plane_mutation')
  })

  it('allows read-only commands via policy rules', () => {
    const result = evaluate('git status')
    expect(result.verdict).toBe('allow')
    expect(result.reason).toBe('read_only')
  })
})
