import path from 'node:path'

import type { BelayConfigV4 } from '../config.js'
import { belayStateDir } from '../config.js'
import type { ClassifyResult } from '../types.js'
import { buildTier1Prompt } from '../verdict/judge.js'
import type { JudgeProviderId } from '../verdict/judge-catalog.js'
import { normalizeJudgeRuntimeConfig } from '../verdict/judge-runtime-config.js'
import {
  judgeShadowAuditFields,
  recordShadowComparison,
  shouldRunShadowComparison,
  triggerJudgeSessionKillSwitch,
} from '../verdict/judge-shadow.js'
import { evaluateWithJudgeTransport } from '../verdict/judge-transport.js'
import type { Tier1Verdict } from '../verdict/types.js'
import { recordPolicyJudgeComparison } from './gate-shadow-ratchet.js'

export { recordGateApprovalAsk } from './gate-shadow-ratchet.js'

export function capabilityDecisionAuditFields(result: ClassifyResult): Record<string, unknown> {
  const fields: Record<string, unknown> = {}
  if (result.capabilityRequests?.length) {
    fields.capabilityRequestCount = result.capabilityRequests.length
    fields.capabilityActions = result.capabilityRequests.map((request) => request.action)
  }
  if (result.authorizationDecision) {
    fields.policyOutcome = result.authorizationDecision.outcome
    fields.policyReason = result.authorizationDecision.reason
    if (result.authorizationDecision.matchedRule) {
      fields.policyMatchedRule = result.authorizationDecision.matchedRule
    }
  }
  if (result.boundaryProfile) {
    fields.boundaryProfile = result.boundaryProfile
  }
  if (result.authorizationDecision?.signals.includes('boundary_materialized_grant')) {
    fields.boundaryGrantMaterialized = true
  }
  return fields
}

export function policyWouldBlock(result: ClassifyResult): boolean {
  const outcome = result.authorizationDecision?.outcome
  if (outcome === 'allow') {
    return false
  }
  if (outcome === 'require_approval' || outcome === 'deny') {
    return true
  }
  return result.verdict === 'deny_pending_approval'
}

export function judgeWouldBlock(verdict: Tier1Verdict): boolean {
  return !verdict.local_recoverable || verdict.destroys_history_or_secrets === true
}

export function policyJudgeMismatch(result: ClassifyResult, judgeVerdict: Tier1Verdict): boolean {
  return policyWouldBlock(result) !== judgeWouldBlock(judgeVerdict)
}

function queueDeferredGatePolicyShadow(params: {
  repoRoot: string
  config: BelayConfigV4
  providerId: Exclude<JudgeProviderId, 'ollama'>
  command: string
  result: ClassifyResult
  stateDir?: string
}): void {
  setImmediate(() => {
    void runGatePolicyShadowComparison(params).catch(() => {})
  })
}

export function scheduleGateShadowAudit(params: {
  repoRoot: string
  config: BelayConfigV4
  providerId: string
  result: ClassifyResult
  command?: string
  stateDir?: string
}): Record<string, unknown> {
  const trace = capabilityDecisionAuditFields(params.result)
  const judge = params.config.judge
  const mode = judge?.mode ?? 'shadow'
  if (mode !== 'shadow' || !judge.runtime?.shadow?.enabled) {
    return trace
  }
  const deferredTrace = {
    ...trace,
    ...judgeShadowAuditFields(params.repoRoot),
    judgeShadowScheduled: false,
    judgeShadowDeferred: true,
  }
  const command = params.command?.trim()
  if (
    !command ||
    params.providerId === 'ollama' ||
    !shouldRunShadowComparison(params.repoRoot, params.providerId, judge.runtime.shadow)
  ) {
    return deferredTrace
  }
  queueDeferredGatePolicyShadow({
    repoRoot: params.repoRoot,
    config: params.config,
    providerId: params.providerId as Exclude<JudgeProviderId, 'ollama'>,
    command,
    result: params.result,
    stateDir: params.stateDir,
  })
  return {
    ...deferredTrace,
    judgeShadowQueued: true,
  }
}

export async function runGatePolicyShadowComparison(params: {
  repoRoot: string
  config: BelayConfigV4
  providerId: Exclude<JudgeProviderId, 'ollama'>
  command: string
  result: ClassifyResult
  stateDir?: string
}): Promise<void> {
  const judge = params.config.judge
  const runtime = normalizeJudgeRuntimeConfig(judge.runtime)
  const stateDir =
    params.stateDir ?? belayStateDir(params.config, path.join(params.repoRoot, '.belay'))
  const transport = await evaluateWithJudgeTransport(
    {
      prompt: buildTier1Prompt(params.command),
      context: {
        providerId: params.providerId,
        model: judge.model ?? 'default',
        repoRoot: params.repoRoot,
        stateDir,
        judgeMode: judge.mode ?? 'shadow',
        runtime,
        judgeTimeoutMs: judge.timeoutMs ?? 25_000,
      },
    },
    { skipTransportShadow: true, spawnOnly: true },
  )
  if (!transport.verdict) {
    return
  }
  const mismatch = policyJudgeMismatch(params.result, transport.verdict)
  const shadow = recordShadowComparison(params.repoRoot, runtime.shadow, mismatch)
  await recordPolicyJudgeComparison(params.repoRoot, stateDir, mismatch)
  if (shadow.killSwitchTriggered) {
    await triggerJudgeSessionKillSwitch(params.repoRoot, stateDir)
  }
}
