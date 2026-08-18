import { appendFile, mkdir } from 'node:fs/promises'
import path from 'node:path'

import { resolveActiveAuditCohort } from '../runtime-provenance.js'
import type { BelayConfigV4 } from './config.js'

export async function appendCliAuditEvent(
  repoRoot: string,
  config: BelayConfigV4,
  event: Record<string, unknown>,
): Promise<void> {
  const auditPath = path.isAbsolute(config.audit.logPath)
    ? config.audit.logPath
    : path.join(repoRoot, config.audit.logPath)
  await mkdir(path.dirname(auditPath), { recursive: true })
  const cohort = await resolveActiveAuditCohort(repoRoot, config)
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    source: 'belay-cli',
    ...(cohort
      ? {
          runtimeBuildStamp: cohort.runtimeBuildStamp,
          configFingerprint: cohort.configFingerprint,
        }
      : {}),
    ...event,
  })
  await appendFile(auditPath, `${line}\n`, 'utf8')
}
