import { resolveActiveAuditCohort } from '../runtime-provenance.js'
import { appendAuditRecord } from './audit-serialize.js'
import { resolveActiveAuditLogPath } from './audit-version-path.js'
import type { BelayConfigV4 } from './config.js'
import { normalizeAuditConfig, scrubOptionsFromConfig } from './config.js'

export {
  AUDIT_SCHEMA_VERSION,
  appendAuditRecord,
  approvalCorrelationId,
  canonicalToolUseIdForCorrelation,
  isValidAuditFingerprint,
  isValidAuditTimestamp,
  parseAuditNdjsonLine,
  serializeAuditRecordV3,
  toolInvocationCorrelationId,
} from './audit-serialize.js'

export async function appendCliAuditEvent(
  repoRoot: string,
  config: BelayConfigV4,
  event: Record<string, unknown>,
): Promise<void> {
  const auditPath = await resolveActiveAuditLogPath(repoRoot, config)
  const cohort = await resolveActiveAuditCohort(repoRoot, config)
  await appendAuditRecord(
    auditPath,
    {
      source: 'belay-cli',
      ...(cohort
        ? {
            runtimeBuildStamp: cohort.runtimeBuildStamp,
            runtimeArtifactHash: cohort.runtimeArtifactHash,
            decisionConfigFingerprint: cohort.decisionConfigFingerprint,
            boundaryProfile: cohort.boundaryProfile,
            configFingerprint: cohort.configFingerprint,
          }
        : {}),
      ...event,
    },
    scrubOptionsFromConfig(config),
    normalizeAuditConfig(config.audit),
  )
}
