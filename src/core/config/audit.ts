import type { AuditRetentionConfig, BelayAuditConfig, NormalizedBelayAuditConfig } from './types.js'

export const DEFAULT_AUDIT_MAX_BYTES = 33_554_432

export const DEFAULT_AUDIT_MAX_FILES = 5

export const MAX_AUDIT_FILES = 100

export const DEFAULT_AUDIT_RETENTION: AuditRetentionConfig = {
  maxBytes: DEFAULT_AUDIT_MAX_BYTES,
  maxFiles: DEFAULT_AUDIT_MAX_FILES,
}

function normalizePositiveInteger(value: unknown, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    return fallback
  }
  const floored = Math.floor(value)
  return floored > 0 ? floored : fallback
}

function normalizeAuditMaxFiles(value: unknown): number {
  if (
    typeof value !== 'number' ||
    !Number.isFinite(value) ||
    value <= 0 ||
    value > MAX_AUDIT_FILES
  ) {
    return DEFAULT_AUDIT_MAX_FILES
  }
  const floored = Math.floor(value)
  return Number.isSafeInteger(floored) && floored >= 1 && floored <= MAX_AUDIT_FILES
    ? floored
    : DEFAULT_AUDIT_MAX_FILES
}

const LEGACY_DISABLED_RETENTION = Symbol('legacy-disabled-audit-retention')

type AuditConfigWithLegacyMarker = Partial<BelayAuditConfig> & {
  [LEGACY_DISABLED_RETENTION]?: true
}

function hasOwn(object: object | undefined, key: PropertyKey): boolean {
  return object !== undefined && Object.hasOwn(object, key)
}

export function normalizeAuditConfig(
  audit: Partial<BelayAuditConfig> | undefined,
): NormalizedBelayAuditConfig {
  const selected = auditConfigWithSourceRetention(
    {
      logPath: 'belay/audit.ndjson',
      includeAssessment: true,
      maxBytes: DEFAULT_AUDIT_MAX_BYTES,
      maxFiles: DEFAULT_AUDIT_MAX_FILES,
    },
    audit,
  )
  const compatibilityRetention = selected.retention
    ? normalizeAuditRetention(selected.retention)
    : undefined
  const { retention: _retention, ...selectedWithoutRetention } = selected
  return {
    ...selectedWithoutRetention,
    logPath: selected.logPath || 'belay/audit.ndjson',
    includeAssessment: selected.includeAssessment !== false,
    maxBytes: normalizePositiveInteger(selected.maxBytes, DEFAULT_AUDIT_MAX_BYTES),
    maxFiles: normalizeAuditMaxFiles(selected.maxFiles),
    ...(compatibilityRetention ? { retention: compatibilityRetention } : {}),
  }
}

export function normalizeAuditRetention(raw?: Partial<AuditRetentionConfig>): AuditRetentionConfig {
  const maxBytes =
    typeof raw?.maxBytes === 'number' && Number.isFinite(raw.maxBytes) && raw.maxBytes >= 0
      ? Math.floor(raw.maxBytes)
      : DEFAULT_AUDIT_MAX_BYTES
  const maxFiles =
    typeof raw?.maxFiles === 'number' &&
    Number.isFinite(raw.maxFiles) &&
    raw.maxFiles >= 0 &&
    raw.maxFiles <= MAX_AUDIT_FILES
      ? Math.floor(raw.maxFiles)
      : DEFAULT_AUDIT_MAX_FILES
  return { maxBytes, maxFiles }
}

export function auditConfigWithSourceRetention(
  defaults: BelayAuditConfig,
  source: Partial<BelayAuditConfig> | undefined,
): BelayAuditConfig {
  const markedSource = source as AuditConfigWithLegacyMarker | undefined
  if (markedSource?.[LEGACY_DISABLED_RETENTION] && source?.retention) {
    return {
      ...defaults,
      ...source,
      retention: normalizeAuditRetention(source.retention),
    }
  }

  const nested = source?.retention
  const normalizedNested = nested ? normalizeAuditRetention(nested) : undefined
  const flatMaxBytesExplicit = hasOwn(source, 'maxBytes')
  const flatMaxFilesExplicit = hasOwn(source, 'maxFiles')
  const nestedMaxBytesExplicit = hasOwn(nested, 'maxBytes')
  const nestedMaxFilesExplicit = hasOwn(nested, 'maxFiles')
  const selectedNestedMaxBytes = !flatMaxBytesExplicit && nestedMaxBytesExplicit
  const selectedNestedMaxFiles = !flatMaxFilesExplicit && nestedMaxFilesExplicit
  const maxBytes = normalizePositiveInteger(
    flatMaxBytesExplicit
      ? source?.maxBytes
      : selectedNestedMaxBytes
        ? normalizedNested?.maxBytes
        : defaults.maxBytes,
    DEFAULT_AUDIT_MAX_BYTES,
  )
  const maxFiles = normalizeAuditMaxFiles(
    flatMaxFilesExplicit
      ? source?.maxFiles
      : selectedNestedMaxFiles
        ? normalizedNested?.maxFiles
        : defaults.maxFiles,
  )
  const nestedMaxBytesDisabled = selectedNestedMaxBytes && normalizedNested?.maxBytes === 0
  const nestedMaxFilesDisabled = selectedNestedMaxFiles && normalizedNested?.maxFiles === 0
  const legacyDisabled = nestedMaxBytesDisabled || nestedMaxFilesDisabled
  const { retention: _retention, ...sourceWithoutRetention } = source ?? {}
  const selected: AuditConfigWithLegacyMarker = {
    ...defaults,
    ...sourceWithoutRetention,
    maxBytes,
    maxFiles,
  }
  if (legacyDisabled) {
    selected.retention = {
      maxBytes: nestedMaxBytesDisabled ? 0 : maxBytes,
      maxFiles: nestedMaxFilesDisabled ? 0 : maxFiles,
    }
    selected[LEGACY_DISABLED_RETENTION] = true
  } else {
    delete selected.retention
    delete selected[LEGACY_DISABLED_RETENTION]
  }
  return selected as BelayAuditConfig
}

export function auditRetentionFromConfig(config: {
  audit?: Partial<BelayAuditConfig>
}): AuditRetentionConfig {
  const normalized = normalizeAuditConfig(config.audit)
  if (normalized.retention) {
    return normalized.retention
  }
  return { maxBytes: normalized.maxBytes, maxFiles: normalized.maxFiles }
}

export function auditConfigForPersistence(audit: BelayAuditConfig): BelayAuditConfig {
  const marked = audit as BelayAuditConfig & AuditConfigWithLegacyMarker
  if (!marked[LEGACY_DISABLED_RETENTION] || !marked.retention) return audit
  const persisted = { ...marked }
  if (marked.retention.maxBytes === 0) delete persisted.maxBytes
  if (marked.retention.maxFiles === 0) delete persisted.maxFiles
  return persisted
}
