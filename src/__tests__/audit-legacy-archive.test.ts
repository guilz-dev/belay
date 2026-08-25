import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import {
  archiveLegacyAuditLogIfNeeded,
  auditLogHasLegacyScrubPlaceholders,
  auditRecordHasLegacyCorrelationPlaceholders,
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
    expect(auditLogHasLegacyScrubPlaceholders('{"approvalCorrelationId":"deadbeefdeadbeef"}')).toBe(
      false,
    )
  })

  it('detects legacy correlation placeholders on gate records only', () => {
    expect(
      auditRecordHasLegacyCorrelationPlaceholders({
        timestamp: '<timestamp>',
        fingerprint: 'abc',
      }),
    ).toBe(true)
    expect(
      auditRecordHasLegacyCorrelationPlaceholders({
        timestamp: '2026-08-24T00:00:00.000Z',
        actionSnapshot: { payloadHash: '<high-entropy>' },
      }),
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
    if (!result.archivedPath) {
      throw new Error('expected archived audit path')
    }
    expect(existsSync(auditPath)).toBe(false)
    expect(existsSync(result.archivedPath)).toBe(true)
    expect(await readFile(result.archivedPath, 'utf8')).toContain('<timestamp>')
  })

  it('archives a legacy placeholder after the first 256 KiB', async () => {
    const repoRoot = await mkdtemp(path.join(os.tmpdir(), 'belay-audit-archive-late-'))
    tempDirs.push(repoRoot)
    const auditPath = path.join(repoRoot, '.cursor', 'belay', 'audit.ndjson')
    await mkdir(path.dirname(auditPath), { recursive: true })
    const cleanLine = '{"timestamp":"2026-08-22T05:00:00.000Z","summary":"ok"}\n'
    await writeFile(
      auditPath,
      `${cleanLine.repeat(Math.ceil(300_000 / cleanLine.length))}{"timestamp":"<timestamp>"}\n`,
      'utf8',
    )

    const config = mergeConfig({
      audit: { logPath: '.cursor/belay/audit.ndjson' },
    })
    const result = await archiveLegacyAuditLogIfNeeded(repoRoot, config)

    expect(result.archived).toBe(true)
    expect(existsSync(auditPath)).toBe(false)
  })

  it('detects a legacy marker split across audit scan chunks', async () => {
    const repoRoot = await mkdtemp(path.join(os.tmpdir(), 'belay-audit-archive-boundary-'))
    tempDirs.push(repoRoot)
    const auditPath = path.join(repoRoot, '.cursor', 'belay', 'audit.ndjson')
    await mkdir(path.dirname(auditPath), { recursive: true })
    const marker = '"decisionConfigFingerprint":"<high-entropy>"'
    const markerOffset = 64 * 1024 - Math.floor(marker.length / 2)
    const jsonPrefix = '{"summary":"'
    const markerSeparator = '",'
    const padding = 'x'.repeat(markerOffset - jsonPrefix.length - markerSeparator.length)
    await writeFile(auditPath, `${jsonPrefix}${padding}${markerSeparator}${marker}}\n`, 'utf8')

    const config = mergeConfig({
      audit: { logPath: '.cursor/belay/audit.ndjson' },
    })
    const result = await archiveLegacyAuditLogIfNeeded(repoRoot, config)

    expect(result.archived).toBe(true)
    expect(existsSync(auditPath)).toBe(false)
  })

  it('leaves clean audit logs untouched', async () => {
    const repoRoot = await mkdtemp(path.join(os.tmpdir(), 'belay-audit-archive-clean-'))
    tempDirs.push(repoRoot)
    const auditPath = path.join(repoRoot, '.cursor', 'belay', 'audit.ndjson')
    await mkdir(path.dirname(auditPath), { recursive: true })
    await writeFile(auditPath, '{"timestamp":"2026-08-22T05:00:00.000Z","summary":"ok"}\n', 'utf8')

    const config = mergeConfig({
      audit: { logPath: '.cursor/belay/audit.ndjson' },
    })
    const result = await archiveLegacyAuditLogIfNeeded(repoRoot, config)

    expect(result.archived).toBe(false)
    expect(existsSync(auditPath)).toBe(true)
  })
})
