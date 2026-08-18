import { createHash } from 'node:crypto'

import {
  type BelayConfigV4,
  DEFAULT_CONFIG_V3,
  DEFAULT_CONFIG_V4,
  mergeConfig,
} from '../core/config.js'
import type { ClassifierOptions } from '../core/types.js'
import type { CoverageContextId } from './coverage-matrix.js'
import { DEFAULT_CORPUS_REPO_ROOT } from './runtime-match.js'
import { structuralFixtureRoot } from './structural-fixture-root.js'

export interface CoverageEvalContext {
  id: CoverageContextId
  config: BelayConfigV4
  cwd: string
  repoRoot: string
  options: ClassifierOptions
}

export function structuralCoverageConfig(): BelayConfigV4 {
  return mergeConfig(
    {
      mode: 'enforce',
      policy: {
        unknownLocalEffect: 'deny',
        unparseableShell: 'deny',
      },
    },
    DEFAULT_CONFIG_V4,
  )
}

export function buildCoverageEvalContexts(
  contextIds: CoverageContextId[],
  repoRoot: string,
): CoverageEvalContext[] {
  const fixtureRoot = structuralFixtureRoot(repoRoot)
  const contexts: CoverageEvalContext[] = []

  for (const contextId of contextIds) {
    if (contextId === 'default') {
      contexts.push({
        id: 'default',
        config: DEFAULT_CONFIG_V3,
        cwd: `${DEFAULT_CORPUS_REPO_ROOT}/src`,
        repoRoot: DEFAULT_CORPUS_REPO_ROOT,
        options: {},
      })
      continue
    }

    if (contextId === 'structural') {
      contexts.push({
        id: 'structural',
        config: structuralCoverageConfig(),
        cwd: fixtureRoot,
        repoRoot: fixtureRoot,
        options: {
          unknownLocalEffect: 'deny',
          unparseableShell: 'deny',
          trustedCwd: true,
        },
      })
    }
  }

  return contexts
}

export function hashStableJson(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

export function resolvedConfigHash(context: CoverageEvalContext): string {
  return hashStableJson({
    mode: context.config.mode,
    policy: context.config.policy,
    gates: context.config.gates,
    classifier: context.config.classifier,
    options: {
      unknownLocalEffect: context.options.unknownLocalEffect,
      unparseableShell: context.options.unparseableShell,
      trustedCwd: context.options.trustedCwd,
    },
    cwd: context.cwd,
    repoRoot: context.repoRoot,
  })
}
