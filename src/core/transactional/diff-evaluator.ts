import path from 'node:path'

import { matchesSensitivePath } from '../glob.js'
import { pathWithinRoot } from '../path-utils.js'
import type { Assessment } from '../types.js'
import type {
  TransactionalDiffContext,
  TransactionalDiffEvaluation,
  TransactionalFileChange,
} from './types.js'

function categorizeChange(
  change: TransactionalFileChange,
  ctx: TransactionalDiffContext,
): TransactionalDiffEvaluation['categories'][number] {
  const absolutePath = path.resolve(ctx.repoRoot, change.relativePath)
  if (!pathWithinRoot(ctx.repoRoot, absolutePath)) {
    return 'repo_outside'
  }
  if (
    ctx.protectedRoots.some((root) => pathWithinRoot(root, absolutePath) || root === absolutePath)
  ) {
    return 'control_plane'
  }
  if (matchesSensitivePath(change.relativePath, ctx.sensitivePaths)) {
    return 'sensitive_path'
  }
  return 'repo_local'
}

function observedAssessment(
  evaluation: Omit<TransactionalDiffEvaluation, 'assessment'>,
): Assessment {
  const signals = ['transactional_observed']
  for (const category of evaluation.categories) {
    if (category !== 'repo_local') {
      signals.push(`observed_${category}`)
    }
  }
  if (evaluation.deletedCount > 0) {
    signals.push('observed_deletions')
  }

  if (
    evaluation.categories.includes('repo_outside') ||
    evaluation.categories.includes('control_plane') ||
    evaluation.categories.includes('sensitive_path')
  ) {
    return {
      reversibility: 'irreversible',
      external: evaluation.categories.includes('repo_outside'),
      blastRadius: evaluation.categories.includes('control_plane')
        ? 'agent-belay control plane'
        : evaluation.categories.includes('repo_outside')
          ? 'outside the repository'
          : 'sensitive path',
      confidence: 1,
      signals,
    }
  }

  if (evaluation.categories.includes('large_deletion')) {
    return {
      reversibility: 'irreversible',
      external: false,
      blastRadius: 'directory tree',
      confidence: 1,
      signals,
    }
  }

  return {
    reversibility: evaluation.deletedCount > 0 ? 'recoverable_with_cost' : 'reversible',
    external: false,
    blastRadius: evaluation.changes.length <= 1 ? 'single file' : 'this repository',
    confidence: 1,
    signals,
  }
}

export function evaluateTransactionalDiff(
  changes: TransactionalFileChange[],
  ctx: TransactionalDiffContext,
): TransactionalDiffEvaluation {
  const categories = new Set<TransactionalDiffEvaluation['categories'][number]>()
  const deletedCount = changes.filter((change) => change.kind === 'deleted').length

  for (const change of changes) {
    categories.add(categorizeChange(change, ctx))
  }
  if (deletedCount > ctx.maxDeletionCount) {
    categories.add('large_deletion')
  }

  const categoryList = [...categories]
  const dangerous =
    categoryList.includes('repo_outside') ||
    categoryList.includes('control_plane') ||
    categoryList.includes('sensitive_path') ||
    categoryList.includes('large_deletion')

  const base = {
    categories: categoryList,
    changes,
    deletedCount,
    verdict: dangerous ? ('deny_pending_approval' as const) : ('allow' as const),
    reason: dangerous ? 'transactional_observed_risk' : 'transactional_observed_safe',
  }

  return {
    ...base,
    assessment: observedAssessment(base),
  }
}
