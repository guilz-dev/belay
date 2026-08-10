export {
  addPathToAllowlist,
  allPathsAllowlisted,
  fsScopeAllowlistPath,
  isPathAllowlisted,
  loadFsScopeAllowlist,
  loadFsScopeAllowlistSync,
  saveFsScopeAllowlist,
} from './allowlist.js'
export {
  attestsWorkspaceMountIsolation,
  BOUNDARY_ATTESTATION_VERSION,
  type BoundaryAttestation,
  type BoundaryDriverId,
  isAttestationFresh,
} from './attestation.js'
export {
  BOUNDARY_PROFILE_L1_ATTESTED,
  BOUNDARY_PROFILE_L3_L4_ONLY,
  BOUNDARY_PROFILE_L3_POLICY,
  boundaryVerifiedAllowEnabled,
  isAttestedBoundary,
  resolveBoundaryProfile,
} from './boundary-profile.js'
export {
  evaluateL1FullStatus,
  hasSandboxRuntime,
  isCapabilityBrokerDemotionActive,
  isSandboxBrokerEnabled,
} from './broker.js'
export {
  CAPABILITY_GRANT_VERSION,
  type CapabilityGrantV1,
  isGrantScopeTooBroad,
} from './grant.js'
export {
  checkGatedActionLimits,
  MAX_SHELL_COMMAND_BYTES,
  MAX_TOOL_PAYLOAD_BYTES,
} from './limits.js'
export { collectOutsideRepoPaths, collectOutsideRepoPathsFromToolPayload } from './paths.js'
export {
  type CapabilityAuthorizationMetadata,
  type PolicyLegacyReasonHints,
  policyDecisionToLegacyReason,
  policyReasonToLegacyReason,
  singleCapabilityMetadata,
} from './policy-bridge.js'
export {
  buildFileMutationCapabilityRequest,
  buildShellCapabilityRequest,
  createTypeScriptPolicyEngine,
  evaluateFileMutationPolicy,
  evaluateShellPolicy,
  evaluateSubagentPolicy,
  type FileMutationCapabilityAnalysis,
  getDefaultPolicyEngine,
  policyDecisionRequiresAsk,
  type ShellCapabilityAnalysis,
  type SubagentCapabilityAnalysis,
} from './policy-engine.js'
export type {
  AuthorizationContext,
  PolicyDecision,
  PolicyEngine,
  PolicyOutcome,
} from './policy-types.js'
export {
  FS_SCOPE_REASONS,
  shouldSkipBrokerApprovedOnce,
  shouldSkipBrokerApprovedRecord,
} from './reasons.js'
export {
  CAPABILITY_REQUEST_VERSION,
  type CapabilityAction,
  type CapabilityEvidence,
  type CapabilityEvidenceLevel,
  type CapabilityHookKind,
  type CapabilityPrincipal,
  type CapabilityRequestContext,
  type CapabilityRequestV1,
  type CapabilityResource,
} from './request.js'
export {
  addTrustedWorkspaceRoot,
  isBroadTrustedWorkspaceRoot,
  isHighStakesTrustedWorkspaceRoot,
  isPathWithinTrustedWorkspaceRoots,
  loadTrustedWorkspaceRoots,
  loadTrustedWorkspaceRootsSync,
  normalizeTrustedWorkspaceRootPath,
  saveTrustedWorkspaceRoots,
  trustedWorkspaceRootsPath,
  validateTrustedWorkspaceRootCandidate,
} from './trusted-workspace-roots.js'
export type {
  CapabilityApprovalScope,
  FsScopeAllowlistEntry,
  FsScopeAllowlistFile,
  TrustedWorkspaceRootEntry,
  TrustedWorkspaceRootsFile,
} from './types.js'
