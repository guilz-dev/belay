import { evaluateShellPolicy, type ShellCapabilityAnalysis } from '../capability/policy-engine.js'
import type { PolicyDecision } from '../capability/policy-types.js'
import type { CapabilityRequestV1 } from '../capability/request.js'
import { cwdRelative } from './containment.js'
import { verdictFingerprint } from './fingerprint.js'
import { redactCommand } from './parser.js'
import type { VerdictContext, VerdictEffect, VerdictLocation, VerdictOpacity } from './types.js'

export interface SegmentShellPolicyInput {
  command: string
  segmentHead: string
  effect: VerdictEffect
  location: VerdictLocation
  opacity: VerdictOpacity
  egressClass?: ShellCapabilityAnalysis['egressClass']
  pathArgs: string[]
  resolvedPathTargets?: string[]
  signals: string[]
  context: VerdictContext
}

function toShellCapabilityAnalysis(input: SegmentShellPolicyInput): ShellCapabilityAnalysis {
  const relative = cwdRelative(input.context.repoRoot, input.context.cwd)
  return {
    command: input.command,
    hookKind: 'shell',
    segmentHead: input.segmentHead,
    effect: input.effect,
    location: input.location,
    opacity: input.opacity,
    egressClass: input.egressClass,
    pathArgs: input.pathArgs,
    resolvedPathTargets: input.resolvedPathTargets,
    signals: input.signals,
    cwd: input.context.cwd,
    repoRoot: input.context.repoRoot,
    inputFingerprint: verdictFingerprint(relative, redactCommand(input.command)),
    trustedWorkspaceRoots: input.context.trustedWorkspaceRoots,
    sensitivePaths: input.context.sensitivePaths,
    protectedArtifactRoots: input.context.protectedArtifactRoots,
  }
}

export function evaluateSegmentShellPolicy(input: SegmentShellPolicyInput): {
  request: CapabilityRequestV1
  decision: PolicyDecision
} {
  return evaluateShellPolicy(toShellCapabilityAnalysis(input), input.context.config, {
    grants: input.context.grants,
    attestation: input.context.attestation,
    egressProxyActive: input.context.egressProxyActive,
  })
}

/** Attach capability metadata without influencing the verdict (audit / shadow only). */
export function shellPolicyMetadata(input: SegmentShellPolicyInput): {
  capabilityRequests: CapabilityRequestV1[]
  authorizationDecision: PolicyDecision
} {
  const result = evaluateSegmentShellPolicy(input)
  return {
    capabilityRequests: [result.request],
    authorizationDecision: result.decision,
  }
}
