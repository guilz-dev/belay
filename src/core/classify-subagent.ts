import { BOUNDARY_PROFILE_L3_L4_ONLY } from './capability/boundary-profile.js'
import { policyReasonToLegacyReason } from './capability/policy-bridge.js'
import { evaluateSubagentPolicy, policyDecisionRequiresAsk } from './capability/policy-engine.js'
import type { BelayConfigV3 } from './config.js'
import { canonicalStringify, subagentFingerprint } from './fingerprint.js'
import { subagentFingerprintSource } from './replay-scrub.js'
import { scrubValue } from './scrub.js'
import type { ClassifierOptions, ClassifyResult } from './types.js'

const EXTERNAL_TERMS = ['deploy', 'production', 'publish', 'release', 'ship', 'notify', 'email']

function extractSubagentText(payload: Record<string, unknown>, options: ClassifierOptions): string {
  const toolInput = payload.tool_input
  if (toolInput && typeof toolInput === 'object') {
    const input = toolInput as Record<string, unknown>
    const description = typeof input.description === 'string' ? input.description : ''
    const prompt = typeof input.prompt === 'string' ? input.prompt : ''
    return [description, prompt].filter(Boolean).join(' ')
  }
  const task = payload.task
  if (typeof task === 'string') {
    return task
  }
  if (task && typeof task === 'object') {
    const taskObj = task as Record<string, unknown>
    const description = typeof taskObj.description === 'string' ? taskObj.description : ''
    const prompt = typeof taskObj.prompt === 'string' ? taskObj.prompt : ''
    return [description, prompt].filter(Boolean).join(' ')
  }
  return canonicalStringify(scrubValue(payload, options.scrubOptions))
}

function fingerprintSource(payload: Record<string, unknown>, options: ClassifierOptions): unknown {
  return subagentFingerprintSource(payload, options.scrubOptions ?? {})
}

export function classifySubagent(
  payload: Record<string, unknown>,
  repoRoot: string,
  options: ClassifierOptions = {},
  config: BelayConfigV3,
): ClassifyResult {
  const kind =
    payload.tool_name === 'Task' ? 'Task' : String(payload.subagent_type ?? 'generalPurpose')
  const scrubbed = fingerprintSource(payload, options)
  const summary = extractSubagentText(payload, options)
  const lowered = summary.toLowerCase()
  const fingerprint = subagentFingerprint(kind, scrubbed, repoRoot)
  const hasExternalTerm = EXTERNAL_TERMS.some((term) => {
    const pattern = new RegExp(`\\b${term}\\b`, 'i')
    return pattern.test(lowered)
  })
  const signals = hasExternalTerm ? ['subagent_external_intent_hint'] : ['subagent_default_review']

  const { request, decision } = evaluateSubagentPolicy(
    {
      subagentType: kind,
      summary,
      repoRoot,
      cwd: repoRoot,
      inputFingerprint: fingerprint,
      signals,
    },
    config,
    {
      grants: options.grants,
      attestation: options.attestation,
      egressProxyActive: options.egressProxyActive,
    },
  )

  if (policyDecisionRequiresAsk(decision)) {
    return {
      verdict: 'deny_pending_approval',
      reason: policyReasonToLegacyReason(decision),
      summary,
      fingerprint,
      assessment: {
        reversibility: 'recoverable_with_cost',
        external: hasExternalTerm,
        blastRadius: 'subagent task scope',
        confidence: hasExternalTerm ? 0.7 : 0.67,
        signals: [...signals, ...decision.signals],
      },
      capabilityRequests: [request],
      authorizationDecision: decision,
    }
  }

  return {
    verdict: 'allow_flagged',
    reason: 'subagent_review',
    summary,
    fingerprint,
    assessment: {
      reversibility: 'recoverable_with_cost',
      external: false,
      blastRadius: 'subagent task scope',
      confidence: hasExternalTerm ? 0.7 : 0.67,
      signals,
    },
    capabilityRequests: [request],
    authorizationDecision: decision,
    boundaryProfile: options.boundaryProfile ?? BOUNDARY_PROFILE_L3_L4_ONLY,
  }
}
