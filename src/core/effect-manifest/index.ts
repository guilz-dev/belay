export { applyEffectManifest } from './apply.js'
export { manifestFingerprint, parseEffectManifestV1, ruleFingerprint } from './codec.js'
export { argvMatchesMatcher, findUniqueMatchingRule } from './matcher.js'
export { manifestFilePath, normalizeManifestBasename } from './paths.js'
export {
  effectManifestTrustDir,
  effectManifestTrustRecordPath,
  loadEffectManifestTrustRecord,
  saveEffectManifestTrustRecord,
} from './trust-store.js'
export type {
  EffectManifestApplicationRole,
  EffectManifestAuditV1,
  EffectManifestTrustRecordV1,
  EffectManifestV1,
} from './types.js'
