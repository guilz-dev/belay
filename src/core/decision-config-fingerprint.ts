import type { BelayConfigV3, BelayConfigV4 } from './config.js'
import { collectActiveEffectManifestRuleFingerprints } from './effect-manifest/trust-cohort.js'
import { canonicalStringify, hashValue } from './fingerprint.js'

/** Hash of config fields that affect authorization decisions (excludes mode, audit paths, judge, notifications). */
export function hashDecisionConfig(config: BelayConfigV3): string {
  const {
    mode: _mode,
    notifications: _notifications,
    audit: _audit,
    judge: _judge,
    redaction: _redaction,
    installScope: _installScope,
    overrides: _overrides,
    tokenPrefix: _tokenPrefix,
    approvalTtlMinutes: _approvalTtlMinutes,
    ...decisionRelevant
  } = config
  return hashValue(canonicalStringify(decisionRelevant))
}

/**
 * Authorization cohort fingerprint including active trusted effect-manifest rules for a checkout.
 * When no trusted rules exist, matches {@link hashDecisionConfig} alone.
 */
export function composeDecisionConfigFingerprint(config: BelayConfigV3, repoRoot?: string): string {
  const configOnly = hashDecisionConfig(config)
  if (!repoRoot) {
    return configOnly
  }
  const fingerprints = collectActiveEffectManifestRuleFingerprints(
    repoRoot,
    config as BelayConfigV4,
  )
  if (fingerprints.length === 0) {
    return configOnly
  }
  const manifestTrust = hashValue(canonicalStringify(fingerprints))
  return hashValue(
    canonicalStringify({
      decisionConfig: configOnly,
      effectManifestTrust: manifestTrust,
    }),
  )
}
