import { appendFile, mkdir } from 'node:fs/promises'
import path from 'node:path'

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
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    source: 'belay-cli',
    ...event,
  })
  await appendFile(auditPath, `${line}\n`, 'utf8')
}
