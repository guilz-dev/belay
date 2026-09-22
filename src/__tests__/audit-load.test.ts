import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { auditProject } from '../commands/audit.js'
import { harvestListProject } from '../commands/harvest.js'
import { loadScopedAuditRecords } from '../core/audit-load.js'
import { resolveVersionedAuditLogPath } from '../core/audit-version-path.js'
import { DEFAULT_CONFIG_V4 } from '../core/config.js'
import { PACKAGE_VERSION } from '../version.js'

const tempDirs: string[] = []

async function createTempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'belay-audit-load-'))
  tempDirs.push(dir)
  return dir
}

describe('audit-load', () => {
  afterEach(async () => {
    await Promise.all(
      tempDirs
        .splice(0)
        .map((dir) =>
          import('node:fs/promises').then(({ rm }) => rm(dir, { recursive: true, force: true })),
        ),
    )
  })

  it('loads active version scope by default and sorts multi-version unions chronologically', async () => {
    const repoRoot = await createTempDir()
    const config = {
      ...DEFAULT_CONFIG_V4,
      audit: {
        ...DEFAULT_CONFIG_V4.audit,
        logPath: '.cursor/belay/audit.ndjson',
      },
    }
    await mkdir(path.join(repoRoot, '.cursor'), { recursive: true })
    await writeFile(
      path.join(repoRoot, '.cursor', 'belay.config.json'),
      `${JSON.stringify(config, null, 2)}\n`,
      'utf8',
    )
    await mkdir(path.join(repoRoot, '.cursor', 'belay'), { recursive: true })
    await mkdir(path.join(repoRoot, '.cursor', 'runtime'), { recursive: true })
    await writeFile(
      path.join(repoRoot, '.cursor', 'runtime', 'core.mjs'),
      `export const RUNTIME_PACKAGE_VERSION = "${PACKAGE_VERSION}";\nexport const RUNTIME_BUILD_STAMP = "${PACKAGE_VERSION}@test";\n`,
      'utf8',
    )

    const oldPath = resolveVersionedAuditLogPath(repoRoot, config.audit.logPath, '0.11.0')
    const activePath = resolveVersionedAuditLogPath(repoRoot, config.audit.logPath, PACKAGE_VERSION)
    await writeFile(
      oldPath,
      [
        '{"timestamp":"2026-09-01T00:00:00.000Z","event":"gate","verdict":"allow"}',
        '{"timestamp":"2026-09-02T00:00:00.000Z","event":"gate","verdict":"ask"}',
      ].join('\n'),
      'utf8',
    )
    await writeFile(
      activePath,
      '{"timestamp":"2026-09-03T00:00:00.000Z","event":"gate","verdict":"allow"}\n',
      'utf8',
    )

    const active = await loadScopedAuditRecords(repoRoot)
    expect(active.scope.mode).toBe('active')
    expect(active.records).toHaveLength(1)
    expect(active.records[0]?.timestamp).toBe('2026-09-03T00:00:00.000Z')

    const all = await loadScopedAuditRecords(repoRoot, { allVersions: true })
    expect(all.scope.forensic).toBe(true)
    expect(all.records.map((record) => record.timestamp)).toEqual([
      '2026-09-01T00:00:00.000Z',
      '2026-09-02T00:00:00.000Z',
      '2026-09-03T00:00:00.000Z',
    ])
  })

  it('keeps harvest reads at the requested target while audit query follows the Cursor anchor', async () => {
    const repoRoot = await createTempDir()
    const child = path.join(repoRoot, 'child')
    const config = {
      ...DEFAULT_CONFIG_V4,
      audit: { ...DEFAULT_CONFIG_V4.audit, logPath: '.cursor/belay/audit.ndjson' },
    }
    await mkdir(path.join(repoRoot, '.cursor', 'belay'), { recursive: true })
    await mkdir(child)
    await writeFile(
      path.join(repoRoot, '.cursor', 'belay.config.json'),
      `${JSON.stringify(config)}\n`,
    )
    await writeFile(
      resolveVersionedAuditLogPath(repoRoot, '.cursor/belay/audit.ndjson', PACKAGE_VERSION),
      '{"timestamp":"2026-09-03T00:00:00.000Z","event":"beforeShellExecution","kind":"shell","verdict":"deny_pending_approval","summary":"parent command"}\n',
    )

    const parentRecords = await loadScopedAuditRecords(repoRoot)
    expect(parentRecords.scope.primaryPath).toBe(
      resolveVersionedAuditLogPath(repoRoot, '.cursor/belay/audit.ndjson', PACKAGE_VERSION),
    )
    expect(parentRecords.records).toHaveLength(1)

    const harvest = await harvestListProject({ targetDir: child })
    expect(harvest.excludedGateEvents).toBe(0)

    const audit = await auditProject({ targetDir: child, subcommand: 'query' })
    expect(audit.subcommand).toBe('query')
    if (audit.subcommand === 'query') {
      expect(audit.count).toBe(1)
      expect(audit.records[0]?.summary).toBe('parent command')
    }
  })
})
