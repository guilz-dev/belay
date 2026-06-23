import type { BelayJudgeShadowConfig } from './judge-runtime-config.js'
import {
  isJudgeSessionKillSwitchPersisted,
  persistJudgeSessionKillSwitch,
} from './judge-session-kill-switch.js'
import type { Tier1Verdict } from './types.js'

export interface JudgeShadowState {
  compared: number
  mismatches: number
  dailyCount: number
  dailyKey: string
  killSwitchTriggered: boolean
  mismatchWindow: boolean[]
}

const shadowStates = new Map<string, JudgeShadowState>()

let clock = () => new Date()
let random = Math.random

export function setJudgeShadowClockForTests(next: () => Date): void {
  clock = next
}

export function setJudgeShadowRandomForTests(next: () => number): void {
  random = next
}

export function resetJudgeShadowState(repoRoot?: string): void {
  if (repoRoot) {
    shadowStates.delete(repoRoot)
    return
  }
  shadowStates.clear()
}

function dailyKeyFor(date: Date): string {
  return date.toISOString().slice(0, 10)
}

function getShadowState(repoRoot: string): JudgeShadowState {
  const existing = shadowStates.get(repoRoot)
  if (existing) {
    const key = dailyKeyFor(clock())
    if (existing.dailyKey !== key) {
      existing.dailyCount = 0
      existing.dailyKey = key
    }
    return existing
  }
  const created: JudgeShadowState = {
    compared: 0,
    mismatches: 0,
    dailyCount: 0,
    dailyKey: dailyKeyFor(clock()),
    killSwitchTriggered: false,
    mismatchWindow: [],
  }
  shadowStates.set(repoRoot, created)
  return created
}

export async function isJudgeSessionKillSwitchActive(
  repoRoot: string,
  stateDir?: string,
): Promise<boolean> {
  if (getShadowState(repoRoot).killSwitchTriggered) {
    return true
  }
  if (stateDir) {
    return isJudgeSessionKillSwitchPersisted(stateDir)
  }
  return false
}

export async function triggerJudgeSessionKillSwitch(
  repoRoot: string,
  stateDir?: string,
  reason = 'shadow_mismatch',
): Promise<void> {
  getShadowState(repoRoot).killSwitchTriggered = true
  if (stateDir) {
    await persistJudgeSessionKillSwitch(stateDir, reason)
  }
}

export function shouldRunShadowComparison(
  repoRoot: string,
  providerId: string,
  config: BelayJudgeShadowConfig,
): boolean {
  if (!config.enabled) {
    return false
  }
  if (!config.providerAllowlist.includes(providerId as never)) {
    return false
  }
  const state = getShadowState(repoRoot)
  if (state.killSwitchTriggered) {
    return false
  }
  if (state.dailyCount >= config.dailyRequestCap) {
    return false
  }
  const rate = Math.min(config.sampleRate, config.sampleRateMax)
  return random() < rate
}

export function verdictsEquivalent(a: Tier1Verdict, b: Tier1Verdict): boolean {
  return (
    a.local_recoverable === b.local_recoverable &&
    a.destroys_history_or_secrets === b.destroys_history_or_secrets
  )
}

export function recordShadowComparison(
  repoRoot: string,
  config: BelayJudgeShadowConfig,
  mismatch: boolean,
): {
  compared: boolean
  mismatch: boolean
  mismatchRateWindow: number
  killSwitchTriggered: boolean
} {
  const state = getShadowState(repoRoot)
  state.compared += 1
  state.dailyCount += 1
  if (mismatch) {
    state.mismatches += 1
  }
  state.mismatchWindow.push(mismatch)
  if (state.mismatchWindow.length > config.windowSize) {
    state.mismatchWindow.shift()
  }

  const windowComparisons = state.mismatchWindow.length
  const windowMismatches = state.mismatchWindow.filter(Boolean).length
  const mismatchRateWindow = windowComparisons === 0 ? 0 : windowMismatches / windowComparisons

  if (
    windowComparisons >= Math.min(10, config.windowSize) &&
    mismatchRateWindow > config.mismatchRateThreshold
  ) {
    state.killSwitchTriggered = true
  }

  return {
    compared: true,
    mismatch,
    mismatchRateWindow,
    killSwitchTriggered: state.killSwitchTriggered,
  }
}

export function judgeShadowAuditFields(repoRoot: string): Record<string, unknown> {
  const state = shadowStates.get(repoRoot)
  if (!state) {
    return {}
  }
  const windowComparisons = state.mismatchWindow.length
  const windowMismatches = state.mismatchWindow.filter(Boolean).length
  return {
    judgeShadowCompared: state.compared > 0,
    judgeShadowMismatch: state.mismatches > 0,
    judgeShadowMismatchRateWindow:
      windowComparisons === 0 ? 0 : windowMismatches / windowComparisons,
    judgeKillSwitchTriggered: state.killSwitchTriggered,
  }
}
