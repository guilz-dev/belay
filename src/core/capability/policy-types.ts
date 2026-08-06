import type { BelayConfigV4 } from '../config.js'
import type { BoundaryAttestation } from './attestation.js'
import type { CapabilityGrantV1 } from './grant.js'
import type { CapabilityRequestV1 } from './request.js'

export type PolicyOutcome = 'allow' | 'require_approval' | 'deny'

export interface PolicyDecision {
  outcome: PolicyOutcome
  reason: string
  signals: string[]
  matchedRule?: string
}

export interface AuthorizationContext {
  config: BelayConfigV4
  grants?: CapabilityGrantV1[]
  attestation?: BoundaryAttestation | null
  trustedWorkspaceRoots?: string[]
}

export interface PolicyEngine {
  evaluate(request: CapabilityRequestV1, context: AuthorizationContext): PolicyDecision
}
