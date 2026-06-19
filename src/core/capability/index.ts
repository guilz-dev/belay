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
  evaluateL1FullStatus,
  hasSandboxRuntime,
  isCapabilityBrokerDemotionActive,
  isSandboxBrokerEnabled,
} from './broker.js'
export { collectOutsideRepoPaths, collectOutsideRepoPathsFromToolPayload } from './paths.js'
export {
  FS_SCOPE_REASONS,
  shouldSkipBrokerApprovedOnce,
  shouldSkipBrokerApprovedRecord,
} from './reasons.js'
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
