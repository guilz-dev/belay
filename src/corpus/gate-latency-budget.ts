/**
 * Gate sync classification latency budgets (measured baselines + CI thresholds).
 * PLAN target: p95 <= 100ms, max <= 500ms for full corpus — ratchet toward these over time.
 */

/** Warm local corpus run (2026-08-06). Step 3 uses max(measured × 1.2, Step 1 floor); floors dominate until re-measured and lowered. */
export const GATE_LATENCY_MEASURED_BASELINE = {
  shell: { p95Ms: 1, maxMs: 1 },
  tool: { p95Ms: 1, maxMs: 1 },
  subagent: { p95Ms: 7, maxMs: 7 },
} as const

/** Step 1 rollout floors — CI thresholds stay at these until measured × 1.2 exceeds them. */
const GATE_LATENCY_STEP1_FLOOR = {
  shell: { p95Ms: 200, maxMs: 1000 },
  tool: { p95Ms: 300, maxMs: 1500 },
  subagent: { p95Ms: 200, maxMs: 1000 },
} as const

function ciBudgetFromBaseline(
  baseline: { p95Ms: number; maxMs: number },
  floor: { p95Ms: number; maxMs: number },
): { p95Ms: number; maxMs: number } {
  return {
    p95Ms: Math.max(floor.p95Ms, Math.ceil(baseline.p95Ms * 1.2)),
    maxMs: Math.max(floor.maxMs, Math.ceil(baseline.maxMs * 1.2)),
  }
}

/** Step 3 CI thresholds: max(measured p95 × 1.2, Step 1 floor). */
export const GATE_LATENCY_BUDGET = {
  shell: ciBudgetFromBaseline(GATE_LATENCY_MEASURED_BASELINE.shell, GATE_LATENCY_STEP1_FLOOR.shell),
  tool: ciBudgetFromBaseline(GATE_LATENCY_MEASURED_BASELINE.tool, GATE_LATENCY_STEP1_FLOOR.tool),
  subagent: ciBudgetFromBaseline(
    GATE_LATENCY_MEASURED_BASELINE.subagent,
    GATE_LATENCY_STEP1_FLOOR.subagent,
  ),
} as const

/** PLAN acceptance targets (quality-loop ratchet goal). */
export const GATE_LATENCY_PLAN_TARGET = {
  p95Ms: 100,
  maxMs: 500,
} as const
