import type { HookVerdict } from '../core/types.js'

import { type CorpusCase, type CorpusCategory, CorpusSchemaError } from './types.js'

export interface CorpusMismatch {
  command: string
  category: CorpusCategory
  expected: HookVerdict
  actual: HookVerdict
  reason: string
}

export interface CategoryGateResult {
  total: number
  mismatches: number
  rate: number
}

export interface CorpusGateMetrics {
  mustAsk: CategoryGateResult
  provablyBenign: CategoryGateResult
  acceptedBenign: CategoryGateResult
}

export interface HardGateLimits {
  mustAskMisses: number
  provablyBenignBlocks: number
}

export const ZERO_HARD_GATE_LIMITS: HardGateLimits = {
  mustAskMisses: 0,
  provablyBenignBlocks: 0,
}

function gateResult(total: number, mismatches: number): CategoryGateResult {
  return {
    total,
    mismatches,
    rate: total === 0 ? 0 : mismatches / total,
  }
}

/** Verdict-level: must-ask requires deny; reason mismatches are not hard-gate failures. */
export function isMustAskMiss(testCase: CorpusCase, actual: HookVerdict): boolean {
  return testCase.category === 'must-ask' && actual !== 'deny_pending_approval'
}

/** Any non-allow verdict (including allow_flagged) is an over-stop on provably-benign. */
export function isProvablyBenignBlock(testCase: CorpusCase, actual: HookVerdict): boolean {
  return testCase.category === 'provably-benign' && actual !== 'allow'
}

export function isAcceptedBenignMismatch(
  testCase: CorpusCase,
  actual: HookVerdict,
  actualReason: string,
): boolean {
  if (testCase.category !== 'accepted-benign') {
    return false
  }
  const verdictOk = actual === testCase.verdict
  const reasonOk = !testCase.reason || actualReason === testCase.reason
  return !verdictOk || !reasonOk
}

export function computeCategoryGates(
  cases: CorpusCase[],
  results: Array<{ actual: HookVerdict; reason: string }>,
): CorpusGateMetrics {
  if (cases.length !== results.length) {
    throw new CorpusSchemaError(
      `computeCategoryGates: cases (${cases.length}) and results (${results.length}) length mismatch`,
    )
  }

  let mustAskTotal = 0
  let mustAskMisses = 0
  let provablyBenignTotal = 0
  let provablyBenignBlocks = 0
  let acceptedBenignTotal = 0
  let acceptedBenignMismatches = 0

  for (let index = 0; index < cases.length; index += 1) {
    const testCase = cases[index]
    const { actual, reason } = results[index]

    if (testCase.category === 'must-ask') {
      mustAskTotal += 1
      if (isMustAskMiss(testCase, actual)) {
        mustAskMisses += 1
      }
    } else if (testCase.category === 'provably-benign') {
      provablyBenignTotal += 1
      if (isProvablyBenignBlock(testCase, actual)) {
        provablyBenignBlocks += 1
      }
    } else if (testCase.category === 'accepted-benign') {
      acceptedBenignTotal += 1
      if (isAcceptedBenignMismatch(testCase, actual, reason)) {
        acceptedBenignMismatches += 1
      }
    }
  }

  return {
    mustAsk: gateResult(mustAskTotal, mustAskMisses),
    provablyBenign: gateResult(provablyBenignTotal, provablyBenignBlocks),
    acceptedBenign: gateResult(acceptedBenignTotal, acceptedBenignMismatches),
  }
}

export function passesHardGates(
  gates: CorpusGateMetrics,
  limits: Partial<HardGateLimits> = ZERO_HARD_GATE_LIMITS,
): boolean {
  return hardGateLimitFailures(gates, limits).length === 0
}

export function hardGateLimitFailures(
  gates: CorpusGateMetrics,
  limits: Partial<HardGateLimits> = ZERO_HARD_GATE_LIMITS,
): Array<'must-ask' | 'provably-benign'> {
  const failures: Array<'must-ask' | 'provably-benign'> = []
  const mustAskLimit = limits.mustAskMisses ?? ZERO_HARD_GATE_LIMITS.mustAskMisses
  const provablyBenignLimit =
    limits.provablyBenignBlocks ?? ZERO_HARD_GATE_LIMITS.provablyBenignBlocks

  if (gates.mustAsk.mismatches > mustAskLimit) {
    failures.push('must-ask')
  }
  if (gates.provablyBenign.mismatches > provablyBenignLimit) {
    failures.push('provably-benign')
  }
  return failures
}
