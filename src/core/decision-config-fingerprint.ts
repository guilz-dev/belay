import type { BelayConfigV3 } from './config.js'
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
