import { describe, expect, it } from 'vitest'

import { assessmentsDiverge } from '../corpus/evaluate.js'

describe('corpus evaluation', () => {
  it('detects prediction vs observation assessment divergence', () => {
    expect(
      assessmentsDiverge(
        {
          reversibility: 'reversible',
          external: false,
          blastRadius: 'single file',
          confidence: 0.72,
          signals: [],
        },
        {
          reversibility: 'irreversible',
          external: false,
          blastRadius: 'directory tree',
          confidence: 1,
          signals: ['transactional_observed'],
        },
      ),
    ).toBe(true)
  })
})
