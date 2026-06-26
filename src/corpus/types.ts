import type { HookVerdict } from '../core/types.js'

/** Action kinds in labeled corpus fixtures. Only `shell` is populated today. */
export const CORPUS_ACTION_KINDS = ['shell'] as const
export type CorpusActionKind = (typeof CORPUS_ACTION_KINDS)[number]

/**
 * Corpus safety labels.
 *
 * - `must-ask`: irreversible or catastrophic — must never be silently allowed (hard gate).
 * - `provably-benign`: structurally benign — must never be blocked (hard gate).
 * - `accepted-benign`: operator-reviewed benign — not a hard gate; may graduate to
 *   `provably-benign` after evidence review.
 */
export const CORPUS_CATEGORIES = ['must-ask', 'provably-benign', 'accepted-benign'] as const
export type CorpusCategory = (typeof CORPUS_CATEGORIES)[number]

export interface CorpusCase {
  /** Fixture action kind. Reserved for future tool/subagent corpora. */
  kind: CorpusActionKind
  category: CorpusCategory
  command: string
  verdict: HookVerdict
  reason?: string
  /**
   * Stable runtime-facing key for `provably-benign` shell cases (verdict fingerprint).
   * Offline fixtures may omit this; loaders derive it via `deriveShellCorpusRuntimeKey`.
   * Consumed by future standing-allow / catalog code — not used by evaluation harness alone.
   */
  runtimeKey?: string
}

export class CorpusSchemaError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CorpusSchemaError'
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parseActionKind(value: unknown, index: number): CorpusActionKind {
  if (value !== 'shell') {
    throw new CorpusSchemaError(
      `case[${index}].kind must be "shell" (got ${JSON.stringify(value)})`,
    )
  }
  return value
}

function parseCategory(value: unknown, index: number): CorpusCategory {
  if (value !== 'must-ask' && value !== 'provably-benign' && value !== 'accepted-benign') {
    throw new CorpusSchemaError(
      `case[${index}].category must be must-ask | provably-benign | accepted-benign (got ${JSON.stringify(value)})`,
    )
  }
  return value
}

function parseVerdict(value: unknown, index: number): HookVerdict {
  if (value !== 'allow' && value !== 'allow_flagged' && value !== 'deny_pending_approval') {
    throw new CorpusSchemaError(`case[${index}].verdict is invalid: ${JSON.stringify(value)}`)
  }
  return value
}

function assertCategoryVerdictConsistency(
  category: CorpusCategory,
  verdict: HookVerdict,
  index: number,
): void {
  if (category === 'must-ask' && verdict !== 'deny_pending_approval') {
    throw new CorpusSchemaError(
      `case[${index}]: must-ask requires verdict deny_pending_approval (got ${verdict})`,
    )
  }
  if (category === 'provably-benign' && verdict !== 'allow') {
    throw new CorpusSchemaError(
      `case[${index}]: provably-benign requires verdict allow (got ${verdict})`,
    )
  }
  if (category === 'accepted-benign' && verdict !== 'allow_flagged') {
    throw new CorpusSchemaError(
      `case[${index}]: accepted-benign requires verdict allow_flagged (got ${verdict})`,
    )
  }
}

export function parseCorpusCases(raw: unknown): CorpusCase[] {
  if (!Array.isArray(raw)) {
    throw new CorpusSchemaError('corpus must be a JSON array')
  }

  return raw.map((entry, index) => {
    if (!isRecord(entry)) {
      throw new CorpusSchemaError(`case[${index}] must be an object`)
    }

    const kind = parseActionKind(entry.kind, index)
    const category = parseCategory(entry.category, index)
    const command = entry.command
    if (typeof command !== 'string' || command.trim() === '') {
      throw new CorpusSchemaError(`case[${index}].command must be a non-empty string`)
    }
    const verdict = parseVerdict(entry.verdict, index)
    assertCategoryVerdictConsistency(category, verdict, index)

    const testCase: CorpusCase = { kind, category, command, verdict }
    if (entry.reason !== undefined) {
      if (typeof entry.reason !== 'string') {
        throw new CorpusSchemaError(`case[${index}].reason must be a string`)
      }
      testCase.reason = entry.reason
    }
    if (entry.runtimeKey !== undefined) {
      if (typeof entry.runtimeKey !== 'string' || entry.runtimeKey.trim() === '') {
        throw new CorpusSchemaError(`case[${index}].runtimeKey must be a non-empty string`)
      }
      if (category !== 'provably-benign') {
        throw new CorpusSchemaError(
          `case[${index}].runtimeKey is only valid for provably-benign cases`,
        )
      }
      testCase.runtimeKey = entry.runtimeKey
    }

    return testCase
  })
}

export function countByCategory(cases: CorpusCase[]): Record<CorpusCategory, number> {
  const counts: Record<CorpusCategory, number> = {
    'must-ask': 0,
    'provably-benign': 0,
    'accepted-benign': 0,
  }
  for (const testCase of cases) {
    counts[testCase.category] += 1
  }
  return counts
}
