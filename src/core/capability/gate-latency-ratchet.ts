import { GATE_LATENCY_BUDGET, GATE_LATENCY_PLAN_TARGET } from '../../corpus/gate-latency-budget.js'

export type GateLatencyKind = keyof typeof GATE_LATENCY_BUDGET

/**
 * Advisory warnings when CI budgets still exceed PLAN acceptance targets.
 * Surfaced via sandbox status `advisories` and doctor warnings — not `issues` or gate exit codes.
 */
export function evaluateGateLatencyRatchetAdvisories(): string[] {
  const warnings: string[] = []
  for (const kind of Object.keys(GATE_LATENCY_BUDGET) as GateLatencyKind[]) {
    const budget = GATE_LATENCY_BUDGET[kind]
    if (budget.p95Ms > GATE_LATENCY_PLAN_TARGET.p95Ms) {
      warnings.push(
        `Gate ${kind} p95 CI budget ${budget.p95Ms}ms exceeds PLAN target ${GATE_LATENCY_PLAN_TARGET.p95Ms}ms — tighten via quality-loop ratchet.`,
      )
    }
    if (budget.maxMs > GATE_LATENCY_PLAN_TARGET.maxMs) {
      warnings.push(
        `Gate ${kind} max CI budget ${budget.maxMs}ms exceeds PLAN target ${GATE_LATENCY_PLAN_TARGET.maxMs}ms — tighten via quality-loop ratchet.`,
      )
    }
  }
  return warnings
}
