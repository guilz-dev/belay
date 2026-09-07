import path from 'node:path'

import { resolveActiveAuditCohort } from '../runtime-provenance.js'
import { appendAuditLine } from './audit-sink.js'
import type { BelayConfigV4 } from './config.js'
import { auditRetentionFromConfig, scrubOptionsFromConfig } from './config.js'

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
  const auditPath = path.isAbsolute(config.audit.logPath)
    ? config.audit.logPath
    : path.join(repoRoot, config.audit.logPath)
  const cohort = await resolveActiveAuditCohort(repoRoot, config)
  await appendAuditLine({
    auditPath,
    record: {
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
    scrubOptions: scrubOptionsFromConfig(config),
    retention: auditRetentionFromConfig(config),
  })
}
