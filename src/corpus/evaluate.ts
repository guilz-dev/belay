import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { classifierOptionsFromConfig, DEFAULT_CONFIG_V3 } from '../core/config.js'
import type { Assessment, HookVerdict } from '../core/types.js'
import { classifyShell } from '../core/verdict/adapter.js'

import {
  type CorpusGateMetrics,
  type CorpusMismatch,
  computeCategoryGates,
  isMustAskMiss,
} from './gates.js'
import { defaultCorpusEvalPaths, enrichProvablyBenignRuntimeKeys } from './runtime-match.js'
import {
  type CorpusCase,
  type CorpusCategory,
  type CorpusProvenanceCounts,
  countByCategory,
  countProvenanceBySource,
  parseCorpusCases,
} from './types.js'

export type {
  CategoryGateResult,
  CorpusGateMetrics,
  CorpusMismatch,
  HardGateLimits,
} from './gates.js'
export {
  computeCategoryGates,
  hardGateLimitFailures,
  isAcceptedBenignMismatch,
  isMustAskMiss,
  isProvablyBenignBlock,
  passesHardGates,
  ZERO_HARD_GATE_LIMITS,
} from './gates.js'
export {
  DEFAULT_CORPUS_REPO_ROOT,
  deriveShellCorpusRuntimeKey,
  enrichProvablyBenignRuntimeKeys,
  provablyBenignShellRuntimeKeys,
} from './runtime-match.js'
export type { CorpusActionKind, CorpusCase, CorpusCategory } from './types.js'
export {
  CORPUS_ACTION_KINDS,
  CORPUS_CATEGORIES,
  CorpusSchemaError,
  parseCorpusCases,
} from './types.js'

export interface CorpusMetrics {
  total: number
  correct: number
  accuracy: number
  precision: Record<string, number>
  recall: Record<string, number>
  /** must-ask cases that were not denied (false negative rate on catastrophic corpus). */
  missRate: number
  /** provably-benign cases that were not silently allowed (over-stop / false positive rate). */
  benignBlockRate: number
  gates: CorpusGateMetrics
  categoryCounts: Record<CorpusCategory, number>
  provenanceCounts: CorpusProvenanceCounts
  mismatches: CorpusMismatch[]
}

export function assessmentsDiverge(predicted: Assessment, observed: Assessment): boolean {
  return (
    predicted.reversibility !== observed.reversibility ||
    predicted.external !== observed.external ||
    predicted.blastRadius !== observed.blastRadius
  )
}

const VERDICTS: HookVerdict[] = ['allow', 'allow_flagged', 'deny_pending_approval']

export async function loadCorpusCases(corpusDir: string): Promise<CorpusCase[]> {
  const raw = await readFile(path.join(corpusDir, 'shell-commands.json'), 'utf8')
  const cases = parseCorpusCases(JSON.parse(raw))
  return enrichProvablyBenignRuntimeKeys(cases)
}

export async function evaluateCorpus(
  cases: CorpusCase[],
  repoRoot = defaultCorpusEvalPaths().repoRoot,
): Promise<CorpusMetrics> {
  const cwd = path.join(repoRoot, 'src')
  const options = classifierOptionsFromConfig(DEFAULT_CONFIG_V3)
  const mismatches: CorpusMismatch[] = []
  const results: Array<{ actual: HookVerdict; reason: string }> = []
  let correct = 0

  const confusion: Record<string, Record<string, number>> = {}
  for (const expected of VERDICTS) {
    confusion[expected] = { allow: 0, allow_flagged: 0, deny_pending_approval: 0 }
  }

  for (const testCase of cases) {
    const result = await classifyShell(testCase.command, cwd, repoRoot, DEFAULT_CONFIG_V3, options)
    results.push({ actual: result.verdict, reason: result.reason })
    confusion[testCase.verdict][result.verdict] += 1
    const verdictOk = result.verdict === testCase.verdict
    const reasonOk = !testCase.reason || result.reason === testCase.reason
    if (verdictOk && reasonOk) {
      correct += 1
    } else {
      mismatches.push({
        command: testCase.command,
        category: testCase.category,
        expected: testCase.verdict,
        actual: result.verdict,
        reason: result.reason,
      })
    }
  }

  const precision: Record<string, number> = {}
  const recall: Record<string, number> = {}
  for (const verdict of VERDICTS) {
    const predicted = VERDICTS.reduce((sum, key) => sum + confusion[key][verdict], 0)
    const truePositive = confusion[verdict][verdict]
    precision[verdict] = predicted === 0 ? 1 : truePositive / predicted
    const actualTotal = VERDICTS.reduce((sum, key) => sum + confusion[verdict][key], 0)
    recall[verdict] = actualTotal === 0 ? 1 : truePositive / actualTotal
  }

  const gates = computeCategoryGates(cases, results)

  return {
    total: cases.length,
    correct,
    accuracy: cases.length === 0 ? 1 : correct / cases.length,
    precision,
    recall,
    missRate: gates.mustAsk.rate,
    benignBlockRate: gates.provablyBenign.rate,
    gates,
    categoryCounts: countByCategory(cases),
    provenanceCounts: countProvenanceBySource(cases),
    mismatches,
  }
}

export async function runCorpusEvaluation(corpusDir?: string): Promise<CorpusMetrics> {
  const root =
    corpusDir ?? path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'corpus')
  const cases = await loadCorpusCases(root)
  return evaluateCorpus(cases)
}

export interface CommandBatchInput {
  command: string
  expected: HookVerdict
  core?: string
  mutatorId?: string
}

export interface CommandBatchResult {
  command: string
  expected: HookVerdict
  actual: HookVerdict
  reason: string
  core?: string
  mutatorId?: string
  isFn: boolean
}

export async function evaluateCommandBatch(
  cases: CommandBatchInput[],
  repoRoot = defaultCorpusEvalPaths().repoRoot,
): Promise<CommandBatchResult[]> {
  const { cwd } = defaultCorpusEvalPaths(repoRoot)
  const options = classifierOptionsFromConfig(DEFAULT_CONFIG_V3)
  const results: CommandBatchResult[] = []

  for (const testCase of cases) {
    const result = await classifyShell(testCase.command, cwd, repoRoot, DEFAULT_CONFIG_V3, options)
    const isFn = isMustAskMiss(
      {
        category: 'must-ask',
        command: testCase.command,
        verdict: testCase.expected,
        kind: 'shell',
      },
      result.verdict,
    )
    results.push({
      command: testCase.command,
      expected: testCase.expected,
      actual: result.verdict,
      reason: result.reason,
      core: testCase.core,
      mutatorId: testCase.mutatorId,
      isFn,
    })
  }

  return results
}

export interface FpCommandBatchResult {
  command: string
  actual: HookVerdict
  reason: string
  core: string
  mutatorId: string
  isFp: boolean
}

/** False-positive probe: must-allow cores that receive deny_pending_approval count as FP. */
export async function evaluateFpCommandBatch(
  cases: Array<{ command: string; core: string; mutatorId: string }>,
  repoRoot = defaultCorpusEvalPaths().repoRoot,
): Promise<FpCommandBatchResult[]> {
  const { cwd } = defaultCorpusEvalPaths(repoRoot)
  const options = classifierOptionsFromConfig(DEFAULT_CONFIG_V3)
  const results: FpCommandBatchResult[] = []

  for (const testCase of cases) {
    const result = await classifyShell(testCase.command, cwd, repoRoot, DEFAULT_CONFIG_V3, options)
    results.push({
      command: testCase.command,
      actual: result.verdict,
      reason: result.reason,
      core: testCase.core,
      mutatorId: testCase.mutatorId,
      isFp: result.verdict === 'deny_pending_approval',
    })
  }

  return results
}
