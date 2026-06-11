import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { classifyShell } from '../core/classify-shell.js'
import { classifierOptionsFromConfig, DEFAULT_CONFIG_V3 } from '../core/config.js'
import type { HookVerdict } from '../core/types.js'

export interface CorpusCase {
  command: string
  verdict: HookVerdict
  reason?: string
}

export interface CorpusMetrics {
  total: number
  correct: number
  accuracy: number
  precision: Record<string, number>
  recall: Record<string, number>
  falsePositiveRate: number
  mismatches: Array<{ command: string; expected: string; actual: string; reason: string }>
}

const VERDICTS: HookVerdict[] = ['allow', 'allow_flagged', 'deny_pending_approval']

export async function loadCorpusCases(corpusDir: string): Promise<CorpusCase[]> {
  const raw = await readFile(path.join(corpusDir, 'shell-commands.json'), 'utf8')
  return JSON.parse(raw) as CorpusCase[]
}

export function evaluateCorpus(
  cases: CorpusCase[],
  repoRoot = '/workspace/project',
): CorpusMetrics {
  const cwd = path.join(repoRoot, 'src')
  const options = classifierOptionsFromConfig(DEFAULT_CONFIG_V3)
  const mismatches: CorpusMetrics['mismatches'] = []
  let correct = 0

  const confusion: Record<string, Record<string, number>> = {}
  for (const expected of VERDICTS) {
    confusion[expected] = { allow: 0, allow_flagged: 0, deny_pending_approval: 0 }
  }

  for (const testCase of cases) {
    const result = classifyShell(testCase.command, cwd, repoRoot, options)
    confusion[testCase.verdict][result.verdict] += 1
    const verdictOk = result.verdict === testCase.verdict
    const reasonOk = !testCase.reason || result.reason === testCase.reason
    if (verdictOk && reasonOk) {
      correct += 1
    } else {
      mismatches.push({
        command: testCase.command,
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

  const falsePositives = mismatches.filter(
    (entry) =>
      entry.expected === 'deny_pending_approval' && entry.actual !== 'deny_pending_approval',
  ).length
  const denyCases = cases.filter((entry) => entry.verdict === 'deny_pending_approval').length

  return {
    total: cases.length,
    correct,
    accuracy: cases.length === 0 ? 1 : correct / cases.length,
    precision,
    recall,
    falsePositiveRate: denyCases === 0 ? 0 : falsePositives / denyCases,
    mismatches,
  }
}

export async function runCorpusEvaluation(corpusDir?: string): Promise<CorpusMetrics> {
  const root =
    corpusDir ?? path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'corpus')
  const cases = await loadCorpusCases(root)
  return evaluateCorpus(cases)
}
