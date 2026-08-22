import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import {
  archiveLegacyAuditLogIfNeeded,
  auditLogHasLegacyScrubPlaceholders,
} from '../core/audit-legacy-archive.js'
import { mergeConfig } from '../core/config.js'

const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

describe('audit legacy archive', () => {
  it('detects scrub placeholders in audit samples', () => {
    expect(auditLogHasLegacyScrubPlaceholders('{"timestamp":"<timestamp>"}')).toBe(true)
    expect(auditLogHasLegacyScrubPlaceholders('{"fingerprint":"<high-entropy>"}')).toBe(true)
    expect(
      auditLogHasLegacyScrubPlaceholders('{"approvalCorrelationId":"deadbeefdeadbeef"}'),
    ).toBe(false)
  })

  it('archives audit logs that contain legacy scrub placeholders', async () => {
    const repoRoot = await mkdtemp(path.join(os.tmpdir(), 'belay-audit-archive-'))
    tempDirs.push(repoRoot)
    const auditPath = path.join(repoRoot, '.cursor', 'belay', 'audit.ndjson')
    await mkdir(path.dirname(auditPath), { recursive: true })
    await writeFile(
      auditPath,
      '{"timestamp":"<timestamp>","fingerprint":"<high-entropy>"}\n',
      'utf8',
    )

    const config = mergeConfig({
      audit: { logPath: '.cursor/belay/audit.ndjson' },
    })
    const result = await archiveLegacyAuditLogIfNeeded(repoRoot, config)

    expect(result.archived).toBe(true)
    expect(result.archivedPath).toBeDefined()
    expect(existsSync(auditPath)).toBe(false)
    expect(existsSync(result.archivedPath!)).toBe(true)
    expect(await readFile(result.archivedPath!, 'utf8')).toContain('<timestamp>')
  })

  it('leaves clean audit logs untouched', async () => {
    const repoRoot = await mkdtemp(path.join(os.tmpdir(), 'belay-audit-archive-clean-'))
    tempDirs.push(repoRoot)
    const auditPath = path.join(repoRoot, '.cursor', 'belay', 'audit.ndjson')
    await mkdir(path.dirname(auditPath), { recursive: true })
    await writeFile(
      auditPath,
      '{"timestamp":"2026-08-22T05:00:00.000Z","summary":"ok"}\n',
      'utf8',
    )

    const config = mergeConfig({
      audit: { logPath: '.cursor/belay/audit.ndjson' },
    })
    const result = await archiveLegacyAuditLogIfNeeded(repoRoot, config)

    expect(result.archived).toBe(false)
    expect(existsSync(auditPath)).toBe(true)
  })
})
