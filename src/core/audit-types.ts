import type { Assessment } from './types.js'

export const AUDIT_METRICS_SCHEMA_VERSION = 2

export const GATE_EVENTS = new Set(['beforeShellExecution', 'preToolUse', 'subagentGate'])

export interface AuditRecord {
  timestamp?: string
  event?: string
  kind?: string
  verdict?: string
  reason?: string
  fingerprint?: string
  summary?: string
  approvalId?: string
  wouldBlock?: boolean
  permission?: string
  mode?: string
  assessment?: Assessment
  predictedAssessment?: Assessment
  observedAssessment?: Assessment
  transactional?: boolean
  transactionalReason?: string
  transactionalCategories?: string[]
  transactionalChangeCount?: number
  transactionalSkipReason?: string
  [key: string]: unknown
}

export interface AuditFilter {
  since?: string
  until?: string
  verdict?: string
  reason?: string
  kind?: string
  fingerprint?: string
  event?: string
  limit?: number
  location?: string
  opacity?: string
  effect?: string
  confidence?: string
}

export interface ApprovalRoundTrip {
  denyTimestamp: string
  approvalTimestamp?: string
  executeTimestamp?: string
  approvalId?: string
  fingerprint: string
  reason: string
  summary: string
  kind: string
  approvalLatencyMs?: number
}

export interface BypassAttempt {
  afterDenyTimestamp: string
  denyFingerprint: string
  denySummary: string
  attemptTimestamp: string
  attemptSummary: string
  attemptFingerprint: string
  signal: 'similar_command' | 'agent_assessment_mismatch' | 'wrapper_pattern'
}

export interface NoisyRuleCandidate {
  reason: string
  denyCount: number
  approvedCount: number
  approvalRate: number
}
