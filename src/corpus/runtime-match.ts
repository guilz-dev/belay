import path from 'node:path'

import { classifierOptionsFromConfig, DEFAULT_CONFIG_V3 } from '../core/config.js'
import { classifyShell } from '../core/verdict/adapter.js'
import { createDeterministicJudgeStub } from '../core/verdict/judge.js'

import { type CorpusCase, CorpusSchemaError } from './types.js'

/** Fixed evaluation harness paths — keep in sync with `evaluateCorpus`. */
export const DEFAULT_CORPUS_REPO_ROOT = '/workspace/project'

export function defaultCorpusEvalPaths(repoRoot = DEFAULT_CORPUS_REPO_ROOT): {
  repoRoot: string
  cwd: string
} {
  return { repoRoot, cwd: path.join(repoRoot, 'src') }
}

/**
 * Derive the shell verdict fingerprint used for runtime matching of `provably-benign`
 * corpus entries. Same key as audit `fingerprint` for the harness cwd/repoRoot.
 */
export async function deriveShellCorpusRuntimeKey(
  command: string,
  repoRoot = DEFAULT_CORPUS_REPO_ROOT,
  cwd = path.join(repoRoot, 'src'),
): Promise<string> {
  const options = classifierOptionsFromConfig(DEFAULT_CONFIG_V3)
  const judge = createDeterministicJudgeStub()
  const result = await classifyShell(command, cwd, repoRoot, DEFAULT_CONFIG_V3, options, judge)
  return result.fingerprint
}

/**
 * Attach derived `runtimeKey` to provably-benign shell cases that omit it.
 * When `runtimeKey` is precomputed in the fixture, verify it matches the derived fingerprint.
 */
export async function enrichProvablyBenignRuntimeKeys(
  cases: CorpusCase[],
  repoRoot = DEFAULT_CORPUS_REPO_ROOT,
  cwd = path.join(repoRoot, 'src'),
): Promise<CorpusCase[]> {
  return Promise.all(
    cases.map(async (testCase) => {
      if (testCase.kind !== 'shell' || testCase.category !== 'provably-benign') {
        return testCase
      }

      const derived = await deriveShellCorpusRuntimeKey(testCase.command, repoRoot, cwd)
      if (testCase.runtimeKey) {
        if (testCase.runtimeKey !== derived) {
          throw new CorpusSchemaError(
            `runtimeKey mismatch for ${JSON.stringify(testCase.command)}: fixture has ${JSON.stringify(testCase.runtimeKey)}, derived ${JSON.stringify(derived)}`,
          )
        }
        return testCase
      }

      return { ...testCase, runtimeKey: derived }
    }),
  )
}

/** Runtime-consumable keys from enriched provably-benign shell fixtures. */
export function provablyBenignShellRuntimeKeys(cases: CorpusCase[]): string[] {
  return cases
    .filter(
      (testCase) =>
        testCase.kind === 'shell' && testCase.category === 'provably-benign' && testCase.runtimeKey,
    )
    .map((testCase) => testCase.runtimeKey as string)
}
