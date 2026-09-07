import { mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { readAuditRecordsFromPath, resolveAuditLogFiles } from '../core/audit-reader.js'
import { appendAuditLine, maybeRotateAuditLog } from '../core/audit-sink.js'
import { DEFAULT_REDACTION_V3 } from '../core/config.js'

const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

describe('audit-sink', () => {
  it('rotates when active file exceeds maxBytes', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'audit-sink-'))
    tempDirs.push(dir)
    const auditPath = path.join(dir, 'audit.ndjson')
    await writeFile(auditPath, `${'x'.repeat(200)}\n`, 'utf8')

    const rotated = await maybeRotateAuditLog(auditPath, { maxBytes: 100, maxFiles: 3 })
    expect(rotated).toBe(true)
    expect(await stat(auditPath)).toBeTruthy()
    const archived = await readFile(`${auditPath}.1`, 'utf8')
    expect(archived.length).toBeGreaterThan(0)
  })

  it('keeps at most maxFiles generations including active', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'audit-sink-'))
    tempDirs.push(dir)
    const auditPath = path.join(dir, 'audit.ndjson')
    const retention = { maxBytes: 10, maxFiles: 5 }

    for (let index = 0; index < 6; index += 1) {
      await writeFile(auditPath, `${'line-'.repeat(index + 1)}\n`, 'utf8')
      await maybeRotateAuditLog(auditPath, retention)
    }

    const files = resolveAuditLogFiles(auditPath, retention)
    expect(files).toHaveLength(5)
    expect(files.some((filePath) => filePath.endsWith('.5'))).toBe(false)
  })

  it('keeps only the active file when maxFiles is one', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'audit-sink-'))
    tempDirs.push(dir)
    const auditPath = path.join(dir, 'audit.ndjson')
    await writeFile(auditPath, '{"event":"active-old"}\n', 'utf8')
    await writeFile(`${auditPath}.1`, '{"event":"archive-old"}\n', 'utf8')

    await maybeRotateAuditLog(auditPath, { maxBytes: 1, maxFiles: 1 })

    expect((await readdir(dir)).sort()).toEqual(['audit.ndjson'])
  })

  it('removes generations above a reduced maxFiles setting', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'audit-sink-'))
    tempDirs.push(dir)
    const auditPath = path.join(dir, 'audit.ndjson')
    await writeFile(auditPath, '{"event":"active"}\n', 'utf8')
    for (let generation = 1; generation <= 4; generation += 1) {
      await writeFile(`${auditPath}.${generation}`, `{"event":"old-${generation}"}\n`, 'utf8')
    }

    await maybeRotateAuditLog(auditPath, { maxBytes: 1, maxFiles: 2 })

    expect((await readdir(dir)).sort()).toEqual(['audit.ndjson', 'audit.ndjson.1'])
  })

  it('appends NDJSON lines through the sink', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'audit-sink-'))
    tempDirs.push(dir)
    const auditPath = path.join(dir, 'audit.ndjson')
    await appendAuditLine({
      auditPath,
      record: { event: 'postToolUse', summary: 'Read src/foo.ts (10 B in, 0 B out)' },
      scrubOptions: DEFAULT_REDACTION_V3,
      retention: { maxBytes: 0, maxFiles: 0 },
    })
    const raw = await readFile(auditPath, 'utf8')
    expect(raw.trim().startsWith('{')).toBe(true)
    expect(raw).toContain('postToolUse')
  })
})

describe('audit-reader', () => {
  it('reads rotated files in chronological order', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'audit-reader-'))
    tempDirs.push(dir)
    const auditPath = path.join(dir, 'audit.ndjson')
    await writeFile(`${auditPath}.1`, '{"event":"old","summary":"archived"}\n', 'utf8')
    await writeFile(auditPath, '{"event":"new","summary":"active"}\n', 'utf8')

    const files = resolveAuditLogFiles(auditPath, { maxBytes: 100, maxFiles: 3 })
    expect(files).toEqual([`${auditPath}.1`, auditPath])

    const { records } = await readAuditRecordsFromPath(auditPath, { maxBytes: 100, maxFiles: 3 })
    expect(records.map((record) => record.event)).toEqual(['old', 'new'])
  })

  it('does not omit a generation when rotation starts during a read', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'audit-reader-'))
    tempDirs.push(dir)
    const auditPath = path.join(dir, 'audit.ndjson')
    const retention = { maxBytes: 1, maxFiles: 3 }
    const archiveRows = [
      '{"event":"archive-before"}',
      ...Array.from({ length: 50_000 }, (_, index) => `{"event":"filler-${index}"}`),
    ]
    await writeFile(`${auditPath}.1`, `${archiveRows.join('\n')}\n`, 'utf8')
    await writeFile(auditPath, '{"event":"active-before"}\n', 'utf8')

    const reading = readAuditRecordsFromPath(auditPath, retention)
    await new Promise((resolve) => setTimeout(resolve, 0))
    await maybeRotateAuditLog(auditPath, retention)
    const { records } = await reading

    expect(
      records
        .map((record) => record.event)
        .filter((event) => event === 'archive-before' || event === 'active-before'),
    ).toEqual(['archive-before', 'active-before'])
  })
})
