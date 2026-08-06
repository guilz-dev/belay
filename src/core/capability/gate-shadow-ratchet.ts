import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'

export interface GateShadowRatchetState {
  version: 1
  policyJudgeComparisons: number
  policyJudgeMismatches: number
  approvalByReason: Record<string, { asks: number; approved: number }>
  updatedAt: string
}

const DEFAULT_STATE: GateShadowRatchetState = {
  version: 1,
  policyJudgeComparisons: 0,
  policyJudgeMismatches: 0,
  approvalByReason: {},
  updatedAt: new Date(0).toISOString(),
}

const MISMATCH_RATE_THRESHOLD = 0.25
const APPROVAL_RATE_THRESHOLD = 0.5
const MIN_SAMPLES = 10

function ratchetPath(stateDir: string): string {
  return path.join(stateDir, 'gate-shadow-ratchet.json')
}

async function loadState(stateDir: string): Promise<GateShadowRatchetState> {
  const filePath = ratchetPath(stateDir)
  if (!existsSync(filePath)) {
    return { ...DEFAULT_STATE, updatedAt: new Date().toISOString() }
  }
  try {
    const raw = JSON.parse(await readFile(filePath, 'utf8')) as GateShadowRatchetState
    return {
      ...DEFAULT_STATE,
      ...raw,
      approvalByReason: raw.approvalByReason ?? {},
    }
  } catch {
    return { ...DEFAULT_STATE, updatedAt: new Date().toISOString() }
  }
}

async function saveState(stateDir: string, state: GateShadowRatchetState): Promise<void> {
  await mkdir(stateDir, { recursive: true, mode: 0o700 })
  await writeFile(
    ratchetPath(stateDir),
    `${JSON.stringify({ ...state, updatedAt: new Date().toISOString() }, null, 2)}\n`,
    { encoding: 'utf8', mode: 0o600 },
  )
}

export async function recordPolicyJudgeComparison(
  repoRoot: string,
  stateDir: string,
  mismatch: boolean,
): Promise<void> {
  void repoRoot
  const state = await loadState(stateDir)
  state.policyJudgeComparisons += 1
  if (mismatch) {
    state.policyJudgeMismatches += 1
  }
  await saveState(stateDir, state)
}

export async function recordGateApprovalAsk(
  stateDir: string,
  reason: string,
  approved: boolean,
): Promise<void> {
  const state = await loadState(stateDir)
  const entry = state.approvalByReason[reason] ?? { asks: 0, approved: 0 }
  if (approved) {
    entry.approved += 1
  } else {
    entry.asks += 1
  }
  state.approvalByReason[reason] = entry
  await saveState(stateDir, state)
}

export function evaluateShadowRatchetWarnings(state: GateShadowRatchetState): string[] {
  const warnings: string[] = []
  if (state.policyJudgeComparisons >= MIN_SAMPLES) {
    const rate = state.policyJudgeMismatches / state.policyJudgeComparisons
    if (rate > MISMATCH_RATE_THRESHOLD) {
      warnings.push(
        `Policy/judge shadow mismatch rate ${(rate * 100).toFixed(0)}% exceeds ${(MISMATCH_RATE_THRESHOLD * 100).toFixed(0)}% threshold (${state.policyJudgeMismatches}/${state.policyJudgeComparisons}).`,
      )
    }
  }
  for (const [reason, counts] of Object.entries(state.approvalByReason)) {
    if (counts.asks < MIN_SAMPLES) {
      continue
    }
    const approvalRate = counts.approved / counts.asks
    if (approvalRate >= APPROVAL_RATE_THRESHOLD) {
      warnings.push(
        `High approval rate for "${reason}": ${(approvalRate * 100).toFixed(0)}% (${counts.approved}/${counts.asks}). Consider tightening policy.`,
      )
    }
  }
  return warnings
}

export async function loadShadowRatchetWarnings(stateDir: string): Promise<string[]> {
  const state = await loadState(stateDir)
  return evaluateShadowRatchetWarnings(state)
}
