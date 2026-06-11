export {
  approvalCommandMatch,
  buildRetryInstruction,
  compactApprovals,
  createApprovalRecord,
  isExpired,
  mergeApprovalStates,
  nowIso,
} from './approval.js'
export type { AuditMetricsReport } from './audit-metrics.js'
export { computeAuditMetrics, parseAuditNdjson } from './audit-metrics.js'
export { classifyShell } from './classify-shell.js'
export { classifySubagent } from './classify-subagent.js'
export { classifyToolUse } from './classify-tool.js'
export {
  approvedApprovalsFile,
  type BelayConfig,
  type BelayConfigV1,
  type BelayConfigV2,
  type BelayConfigV3,
  type BelayControlPlaneConfig,
  type BelayOverridesConfig,
  type BelayPolicyConfig,
  type BelayRedactionConfig,
  belayStateDir,
  classifierOptionsFromConfig,
  configuredControlPlaneDir,
  DEFAULT_CONFIG_V2,
  DEFAULT_CONFIG_V3,
  defaultControlPlaneDir,
  isFreshConfigInput,
  LEGACY_POLICY_V3,
  mapLegacyClassifierToOverrides,
  mergeConfig,
  migrateConfig,
  migrateV2ToV3,
  normalizeConfig,
  pendingApprovalsFile,
  resolveControlPlaneDir,
  scrubOptionsFromConfig,
} from './config.js'
export {
  persistControlPlaneSpikeResult,
  runControlPlaneSpike,
} from './control-plane-spike.js'
export { matchesCustomCommand } from './custom-command-match.js'
export {
  canonicalStringify,
  hashValue,
  shellFingerprint,
  subagentFingerprint,
  toolFingerprint,
} from './fingerprint.js'
export type {
  GatedAction,
  GatedActionKind,
  GatePermissionResponse,
  GateVerdict,
} from './gate-contract.js'
export {
  classifyResultToGateVerdict,
  GATE_CONTRACT_VERSION,
  isGatedAction,
  unnormalizedGateVerdict,
} from './gate-contract.js'
export {
  classifyGatedAction,
  GateNormalizationError,
  gateEnabledForAction,
  normalizeGatedAction,
} from './gate-engine.js'
export { matchesSensitivePath } from './glob.js'
export {
  hasOutsideRepoPath,
  normalizeToken,
  pathWithinRoot,
  relativeWithinRepo,
  resolveMutationTarget,
} from './path-utils.js'
export { scrubString, scrubValue } from './scrub.js'
export { findCommandSubstitutions, MAX_SUBSTITUTION_DEPTH } from './shell-substitution.js'
export type {
  TransactionalDiffEvaluation,
  TransactionalExecutionResult,
} from './transactional/index.js'
export { isTransactionalEligible, runTransactionalExecution } from './transactional/index.js'
export type {
  ApprovalRecord,
  ApprovalStateFile,
  Assessment,
  ClassifierOptions,
  ClassifyResult,
  HookVerdict,
  Reversibility,
  ScrubOptions,
  UnknownLocalEffectPolicy,
} from './types.js'
