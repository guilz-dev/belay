import { describe, expect, it } from 'vitest'

import { mergeAgentAssessment, verdictFromConfidence } from '../core/judgment.js'
import type { Assessment } from '../core/types.js'

describe('judgment', () => {
  it('maps confidence thresholds to verdicts', () => {
    const high: Assessment = {
      reversibility: 'reversible',
      external: false,
      blastRadius: 'repo',
      confidence: 0.95,
      signals: [],
    }
    expect(verdictFromConfidence(high, { allow: 0.88, flag: 0.72 }, 'deny')).toBe('allow')
  })

  it('escalates when agent assessment disagrees with independent judgment', () => {
    const independent: Assessment = {
      reversibility: 'irreversible',
      external: true,
      blastRadius: 'external',
      confidence: 0.92,
      signals: ['external_command'],
    }
    const agent: Assessment = {
      reversibility: 'reversible',
      external: false,
      blastRadius: 'none',
      confidence: 0.99,
      signals: [],
    }
    const merged = mergeAgentAssessment(independent, agent)
    expect(merged.mismatch).toBe(true)
    expect(merged.assessment.signals).toContain('agent_assessment_mismatch')
  })
})
