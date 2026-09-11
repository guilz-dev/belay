import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import {
  listAllVersionedAuditLogPaths,
  resolveAuditLogDirectory,
  resolveVersionedAuditLogPath,
  versionedAuditLogFileName,
} from '../core/audit-version-path.js'

const tempDirs: string[] = []

async function createTempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'belay-audit-version-'))
  tempDirs.push(dir)
  return dir
}

describe('audit-version-path', () => {
  afterEach(async () => {
    await Promise.all(
      tempDirs
        .splice(0)
        .map((dir) =>
          import('node:fs/promises').then(({ rm }) => rm(dir, { recursive: true, force: true })),
        ),
    )
  })

  it('builds versioned audit file names', () => {
    expect(versionedAuditLogFileName('0.12.0')).toBe('v0.12.0.log')
    expect(versionedAuditLogFileName('v0.11.0')).toBe('v0.11.0.log')
  })

  it('treats legacy audit.ndjson config paths as directories', () => {
    const repoRoot = '/tmp/project'
    expect(resolveAuditLogDirectory(repoRoot, '.cursor/belay/audit.ndjson')).toBe(
      '/tmp/project/.cursor/belay',
    )
    expect(resolveVersionedAuditLogPath(repoRoot, '.cursor/belay/audit.ndjson', '0.12.0')).toBe(
      '/tmp/project/.cursor/belay/v0.12.0.log',
    )
  })

  it('lists versioned audit logs for forensic reads', async () => {
    const repoRoot = await createTempDir()
    const auditDir = path.join(repoRoot, '.cursor', 'belay')
    await mkdir(auditDir, { recursive: true })
    await writeFile(path.join(auditDir, 'v0.11.0.log'), '{"event":"legacy"}\n')
    await writeFile(path.join(auditDir, 'v0.12.0.log'), '{"event":"current"}\n')
    await writeFile(path.join(auditDir, 'v0.12.0.log.1'), '{"event":"rotated"}\n')
    await writeFile(path.join(auditDir, 'audit.ndjson'), '{"event":"legacy-flat"}\n')

    expect(listAllVersionedAuditLogPaths(auditDir)).toEqual([
      path.join(auditDir, 'v0.11.0.log'),
      path.join(auditDir, 'v0.12.0.log'),
      path.join(auditDir, 'v0.12.0.log.1'),
    ])
  })
})
