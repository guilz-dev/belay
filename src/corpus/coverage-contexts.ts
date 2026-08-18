import { createHash } from 'node:crypto'
import path from 'node:path'

import { loadLayeredConfig } from '../config-io.js'
import {
  type BelayConfigV4,
  DEFAULT_CONFIG_V3,
  DEFAULT_CONFIG_V4,
  mergeConfig,
} from '../core/config.js'
import type { ConfigProvenanceEntry } from '../core/config-layers.js'
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
  configProvenance?: ConfigProvenanceEntry[]
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

export async function buildCoverageEvalContexts(
  contextIds: CoverageContextId[],
  repoRoot: string,
): Promise<CoverageEvalContext[]> {
  const resolvedRepoRoot = path.resolve(repoRoot)
  const fixtureRoot = structuralFixtureRoot(resolvedRepoRoot)
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
      continue
    }

    if (contextId === 'audit') {
      const layered = await loadLayeredConfig(resolvedRepoRoot)
      contexts.push({
        id: 'audit',
        config: layered.config,
        cwd: resolvedRepoRoot,
        repoRoot: resolvedRepoRoot,
        options: {},
        configProvenance: layered.provenance,
      })
    }
  }

  return contexts
}

export function stableJsonStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableJsonStringify(entry)).join(',')}]`
  }
  const record = value as Record<string, unknown>
  const keys = Object.keys(record).sort()
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableJsonStringify(record[key])}`).join(',')}}`
}

export function hashStableJson(value: unknown): string {
  return createHash('sha256').update(stableJsonStringify(value)).digest('hex')
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
    configProvenance: context.configProvenance,
  })
}
