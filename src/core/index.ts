export {
  APPROVAL_EXECUTION_LEASE_MS,
  approvalCommandMatch,
  compactApprovals,
  createApprovalRecord,
  createApprovalRecordWithEnvelope,
  isExecutionLeaseExpired,
  isExpired,
  mergeApprovalStates,
  nowIso,
} from './approval.js'
export type {
  ApprovalReplayHint,
  ReplayActionContext,
  ReplayAdapterId,
} from './approval-replay.js'
/** @deprecated Use `buildRetryInstructionForConfig` */
export {
  approvalFlow,
  buildApprovalRecordedMessage,
  buildReplayEnvelopeFields,
  buildReplayHint,
  buildRetryInstructionForConfig,
  buildRetryInstructionForConfig as buildRetryInstruction,
  canAutoReplay,
  getExecutionLeaseMs,
  replayShellCommand,
  validateReplayEnvelope,
} from './approval-replay.js'
export type { ApprovalStore } from './approval-service.js'
export {
  claimApprovedForReplay,
  consumeApprovedAfterCliReplay,
  createGateApprovalStore,
  gateApprovalStoreFromDeps,
  recordApproval,
} from './approval-service.js'
export type { AuditMetricsReport } from './audit-metrics.js'
export { computeAuditMetrics, parseAuditNdjson } from './audit-metrics.js'
export { classifySubagent } from './classify-subagent.js'
export { classifyToolUse } from './classify-tool.js'
export {
  type ApprovalFlow,
  approvedApprovalsFile,
  type BelayApprovalAutoReplayScopes,
  type BelayApprovalConfig,
  type BelayConfig,
  type BelayConfigV1,
  type BelayConfigV2,
  type BelayConfigV3,
  type BelayConfigV4,
  type BelayControlPlaneConfig,
  type BelayJudgeConfig,
  type BelayOverridesConfig,
  type BelayPolicyConfig,
  type BelayRedactionConfig,
  belayStateDir,
  classifierOptionsFromConfig,
  configuredControlPlaneDir,
  DEFAULT_APPROVAL_CONFIG,
  DEFAULT_CONFIG_V2,
  DEFAULT_CONFIG_V3,
  DEFAULT_CONFIG_V4,
  DEFAULT_JUDGE_CURSOR_COMPOSER,
  DEFAULT_JUDGE_LOCAL_OLLAMA,
  defaultControlPlaneDir,
  isConfigV4,
  isFreshConfigInput,
  LEGACY_POLICY_V3,
  mapLegacyClassifierToOverrides,
  mergeConfig,
  migrateConfig,
  migrateV2ToV3,
  normalizeConfig,
  normalizeJudgeConfig,
  pendingApprovalsFile,
  resolveControlPlaneDir,
  scrubOptionsFromConfig,
} from './config.js'
export { isContainedUnknownExecutionEligible } from './contained-execution/eligibility.js'
export type {
  ContainedExecutionMirrorBackend,
  ContainedExecutionMirrorHandle,
  ContainedExecutionMirrorOptions,
} from './contained-execution/mirror.js'
export {
  CONTAINED_EXECUTION_CLEANUP_UNCONFIRMED,
  CONTAINED_EXECUTION_SOURCE_CHANGED,
  ContainedExecutionCleanupUnconfirmedError,
  prepareContainedExecutionMirror,
  withContainedExecutionMirror,
} from './contained-execution/mirror.js'
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
export type {
  GitResourceIdentity,
  GitResourceIdentityInspection,
} from './git-resource-identity.js'
export {
  inspectGitResourceIdentity,
  isGitMetadataPath,
  resolveGitResourceIdentity,
  sameGitResourceIdentity,
} from './git-resource-identity.js'
export { matchesSensitivePath } from './glob.js'
export {
  canonicalPath,
  hasOutsideRepoPath,
  normalizeToken,
  pathWithinRoot,
  relativeWithinRepo,
  resolveMutationTarget,
} from './path-utils.js'
export type {
  RecoveryBackend,
  RecoveryCheckpointEntry,
  RecoveryCheckpointEntryV1,
  RecoveryCheckpointEntryV2,
  RecoveryCheckpointManifest,
  RecoveryCheckpointManifestV1,
  RecoveryCheckpointManifestV2,
  RecoveryCheckpointState,
  RecoveryCheckpointSummary,
  RecoveryFileSnapshotV1,
  RecoveryFileSnapshotV2,
  RecoveryProofV1,
  RecoveryReceiptV1,
} from './recovery/index.js'
export {
  listRecoveryCheckpoints,
  RECOVERY_CHECKPOINT_CORRUPT,
  RECOVERY_CHECKPOINT_QUOTA,
  RECOVERY_RESTORE_CONFLICT,
  recoveryCheckpointStorageBytes,
  recoveryRestoreBinding,
  restoreRecoveryCheckpoint,
  showRecoveryCheckpoint,
} from './recovery/index.js'
export { fingerprintReplayPayload, subagentFingerprintSource } from './replay-scrub.js'
export { scrubString, scrubValue } from './scrub.js'
export { findCommandSubstitutions, MAX_SUBSTITUTION_DEPTH } from './shell-substitution.js'
export type {
  TransactionalDiffEvaluation,
  TransactionalExecutionResult,
} from './transactional/index.js'
export { isTransactionalEligible, runTransactionalExecution } from './transactional/index.js'
export type {
  ApprovalRecord,
  ApprovalScopeHint,
  ApprovalStateFile,
  Assessment,
  ClassifierOptions,
  ClassifyResult,
  HookVerdict,
  Reversibility,
  ScrubOptions,
  UnknownLocalEffectPolicy,
} from './types.js'
export {
  buildVerdictContext,
  classifyShell,
  verdict,
  verdictToClassifyResult,
} from './verdict/index.js'
