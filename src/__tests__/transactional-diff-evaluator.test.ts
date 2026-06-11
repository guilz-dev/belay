import { describe, expect, it } from 'vitest'
import { evaluateTransactionalDiff } from '../core/transactional/diff-evaluator.js'

const repoRoot = '/workspace/project'
const diffContext = {
  repoRoot,
  sensitivePaths: ['.env', '.env.*', '**/credentials/**'],
  protectedRoots: [`${repoRoot}/.cursor/belay.config.json`],
  maxDeletionCount: 2,
}

describe('transactional diff evaluator', () => {
  it('allows safe in-repo file creation', () => {
    const evaluation = evaluateTransactionalDiff(
      [{ relativePath: 'notes.txt', kind: 'added' }],
      diffContext,
    )
    expect(evaluation.verdict).toBe('allow')
    expect(evaluation.reason).toBe('transactional_observed_safe')
    expect(evaluation.assessment.confidence).toBe(1)
    expect(evaluation.assessment.signals).toContain('transactional_observed')
  })

  it('denies repo-outside changes', () => {
    const evaluation = evaluateTransactionalDiff(
      [{ relativePath: '../outside.txt', kind: 'added' }],
      diffContext,
    )
    expect(evaluation.verdict).toBe('deny_pending_approval')
    expect(evaluation.categories).toContain('repo_outside')
    expect(evaluation.assessment.external).toBe(true)
  })

  it('denies sensitive path mutations', () => {
    const evaluation = evaluateTransactionalDiff(
      [{ relativePath: '.env', kind: 'modified' }],
      diffContext,
    )
    expect(evaluation.verdict).toBe('deny_pending_approval')
    expect(evaluation.categories).toContain('sensitive_path')
  })

  it('denies control-plane mutations', () => {
    const evaluation = evaluateTransactionalDiff(
      [{ relativePath: '.cursor/belay.config.json', kind: 'modified' }],
      diffContext,
    )
    expect(evaluation.verdict).toBe('deny_pending_approval')
    expect(evaluation.categories).toContain('control_plane')
  })

  it('denies large deletions', () => {
    const evaluation = evaluateTransactionalDiff(
      [
        { relativePath: 'a.txt', kind: 'deleted' },
        { relativePath: 'b.txt', kind: 'deleted' },
        { relativePath: 'c.txt', kind: 'deleted' },
      ],
      diffContext,
    )
    expect(evaluation.verdict).toBe('deny_pending_approval')
    expect(evaluation.categories).toContain('large_deletion')
  })
})
