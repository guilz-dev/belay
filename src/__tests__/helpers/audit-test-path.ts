import { resolveVersionedAuditLogPath } from '../../core/audit-version-path.js'
import { PACKAGE_VERSION } from '../../version.js'

export function testAuditLogPath(repoRoot: string, configuredLogPath: string): string {
  return resolveVersionedAuditLogPath(repoRoot, configuredLogPath, PACKAGE_VERSION)
}
