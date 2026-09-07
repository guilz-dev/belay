import { createHash } from 'node:crypto'
import { lstat, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'
import { appendBoundedAuditLine } from '../core/audit-storage.js'

const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

async function createAuditPath(prefix: string): Promise<string> {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), prefix))
  tempDirs.push(tempDir)
  return path.join(tempDir, 'audit.ndjson')
}

async function expectMissing(filePath: string): Promise<void> {
  await expect(lstat(filePath)).rejects.toMatchObject({ code: 'ENOENT' })
}

function rotatingLine(fingerprint: string): string {
  return JSON.stringify({ fingerprint, padding: 'x'.repeat(50) })
}

describe('appendBoundedAuditLine', () => {
  it('appends below the byte limit and normalizes multiple trailing newlines to one', async () => {
    const auditPath = await createAuditPath('belay-audit-storage-append-')
    const line = JSON.stringify({ fingerprint: 'single' })

    await appendBoundedAuditLine({
      auditPath,
      line: `${line}\n\n`,
      maxBytes: 128,
      maxFiles: 3,
    })

    expect(await readFile(auditPath, 'utf8')).toBe(`${line}\n`)
    await expectMissing(`${auditPath}.1`)
    await expectMissing(`${auditPath}.lock`)
  })

  it('rotates before append with .1 newest and removes only the configured oldest path', async () => {
    const auditPath = await createAuditPath('belay-audit-storage-rotate-')
    const legacyPath = `${auditPath}.legacy-20260908T000000Z.ndjson`
    const outsideRetentionPath = `${auditPath}.3`
    const unrelatedPath = path.join(path.dirname(auditPath), 'notes.txt')
    await writeFile(legacyPath, 'legacy\n', 'utf8')
    await writeFile(outsideRetentionPath, 'outside-retention\n', 'utf8')
    await writeFile(unrelatedPath, 'unrelated\n', 'utf8')
    const lines = ['one', 'two', 'three', 'four', 'five'].map(rotatingLine)
    expect(Buffer.byteLength(`${lines[0]}\n`, 'utf8')).toBeLessThan(128)
    expect(Buffer.byteLength(`${lines[0]}\n${lines[1]}\n`, 'utf8')).toBeGreaterThan(128)

    for (const line of lines) {
      await appendBoundedAuditLine({ auditPath, line, maxBytes: 128, maxFiles: 3 })
    }

    expect(await readFile(auditPath, 'utf8')).toBe(`${lines[4]}\n`)
    expect(await readFile(`${auditPath}.1`, 'utf8')).toBe(`${lines[3]}\n`)
    expect(await readFile(`${auditPath}.2`, 'utf8')).toBe(`${lines[2]}\n`)
    expect(await readFile(outsideRetentionPath, 'utf8')).toBe('outside-retention\n')
    expect(await readFile(legacyPath, 'utf8')).toBe('legacy\n')
    expect(await readFile(unrelatedPath, 'utf8')).toBe('unrelated\n')
  })

  it('retains only the new active line when maxFiles is one', async () => {
    const auditPath = await createAuditPath('belay-audit-storage-one-file-')
    const first = rotatingLine('first')
    const second = rotatingLine('second')

    await appendBoundedAuditLine({ auditPath, line: first, maxBytes: 128, maxFiles: 1 })
    await appendBoundedAuditLine({ auditPath, line: second, maxBytes: 128, maxFiles: 1 })

    expect(await readFile(auditPath, 'utf8')).toBe(`${second}\n`)
    await expectMissing(`${auditPath}.1`)
  })

  it('stores one oversized record whole after rotating the prior active file', async () => {
    const auditPath = await createAuditPath('belay-audit-storage-oversized-')
    const first = JSON.stringify({ fingerprint: 'first' })
    const oversized = JSON.stringify({ fingerprint: 'oversized', padding: 'x'.repeat(256) })
    expect(Buffer.byteLength(`${oversized}\n`, 'utf8')).toBeGreaterThan(32)

    await appendBoundedAuditLine({ auditPath, line: first, maxBytes: 32, maxFiles: 2 })
    await appendBoundedAuditLine({ auditPath, line: oversized, maxBytes: 32, maxFiles: 2 })

    expect(await readFile(auditPath, 'utf8')).toBe(`${oversized}\n`)
    expect(await readFile(`${auditPath}.1`, 'utf8')).toBe(`${first}\n`)
    expect(JSON.parse((await readFile(auditPath, 'utf8')).trim())).toMatchObject({
      fingerprint: 'oversized',
    })
  })

  it('serializes parallel writers without losing, duplicating, or corrupting records', async () => {
    const auditPath = await createAuditPath('belay-audit-storage-parallel-')
    const fingerprints = Array.from({ length: 24 }, (_, index) =>
      createHash('sha256').update(`writer-${index}`).digest('hex'),
    )

    await Promise.all(
      fingerprints.map((fingerprint, writer) =>
        appendBoundedAuditLine({
          auditPath,
          line: JSON.stringify({ fingerprint, writer, padding: 'x'.repeat(20) }),
          maxBytes: 512,
          maxFiles: 7,
        }),
      ),
    )

    const retainedPaths = [
      ...Array.from({ length: 6 }, (_, index) => `${auditPath}.${6 - index}`),
      auditPath,
    ]
    const retainedLines: string[] = []
    for (const retainedPath of retainedPaths) {
      try {
        retainedLines.push(
          ...(await readFile(retainedPath, 'utf8')).split('\n').filter((line) => line.length > 0),
        )
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
    }
    const parsed = retainedLines.map((line) => JSON.parse(line) as { fingerprint: string })

    expect(parsed).toHaveLength(fingerprints.length)
    expect(new Set(parsed.map((record) => record.fingerprint))).toEqual(new Set(fingerprints))
    for (const fingerprint of fingerprints) {
      expect(parsed.filter((record) => record.fingerprint === fingerprint)).toHaveLength(1)
    }
    await expectMissing(`${auditPath}.lock`)
  })

  it('rejects a symlinked active path without mutating its target or siblings', async () => {
    const auditPath = await createAuditPath('belay-audit-storage-active-symlink-')
    const externalPath = path.join(path.dirname(auditPath), 'external.ndjson')
    const unrelatedPath = path.join(path.dirname(auditPath), 'unrelated.txt')
    await writeFile(externalPath, 'external-owner\n', 'utf8')
    await writeFile(unrelatedPath, 'unrelated\n', 'utf8')
    await symlink(externalPath, auditPath)

    await expect(
      appendBoundedAuditLine({
        auditPath,
        line: JSON.stringify({ fingerprint: 'blocked' }),
        maxBytes: 128,
        maxFiles: 3,
      }),
    ).rejects.toThrow(/symbolic link/i)

    expect((await lstat(auditPath)).isSymbolicLink()).toBe(true)
    expect(await readFile(externalPath, 'utf8')).toBe('external-owner\n')
    expect(await readFile(unrelatedPath, 'utf8')).toBe('unrelated\n')
    await expectMissing(`${auditPath}.1`)
    await expectMissing(`${auditPath}.lock`)
  })

  it('rejects a symlinked sibling lock without following or removing it', async () => {
    const auditPath = await createAuditPath('belay-audit-storage-lock-symlink-')
    const lockOwnerPath = path.join(path.dirname(auditPath), 'lock-owner.txt')
    await writeFile(auditPath, 'existing\n', 'utf8')
    await writeFile(lockOwnerPath, 'other-owner\n', 'utf8')
    await symlink(lockOwnerPath, `${auditPath}.lock`)

    await expect(
      appendBoundedAuditLine({
        auditPath,
        line: JSON.stringify({ fingerprint: 'blocked' }),
        maxBytes: 128,
        maxFiles: 3,
      }),
    ).rejects.toThrow(/symbolic link/i)

    expect((await lstat(`${auditPath}.lock`)).isSymbolicLink()).toBe(true)
    expect(await readFile(`${auditPath}.lock`, 'utf8')).toBe('other-owner\n')
    expect(await readFile(lockOwnerPath, 'utf8')).toBe('other-owner\n')
    expect(await readFile(auditPath, 'utf8')).toBe('existing\n')
  })

  it('times out within the bounded retry window without touching any existing path', async () => {
    const auditPath = await createAuditPath('belay-audit-storage-lock-timeout-')
    const lockPath = `${auditPath}.lock`
    const generationPath = `${auditPath}.1`
    const legacyPath = `${auditPath}.legacy-20260908T000000Z.ndjson`
    const unrelatedPath = path.join(path.dirname(auditPath), 'unrelated.txt')
    await writeFile(auditPath, 'active-owner\n', 'utf8')
    await writeFile(lockPath, 'other-lock-owner\n', 'utf8')
    await writeFile(generationPath, 'generation-owner\n', 'utf8')
    await writeFile(legacyPath, 'legacy-owner\n', 'utf8')
    await writeFile(unrelatedPath, 'unrelated-owner\n', 'utf8')
    const startedAt = Date.now()

    await expect(
      appendBoundedAuditLine({
        auditPath,
        line: JSON.stringify({ fingerprint: 'blocked' }),
        maxBytes: 1,
        maxFiles: 2,
      }),
    ).rejects.toThrow(/audit lock.*timed out/i)
    const elapsedMs = Date.now() - startedAt

    expect(elapsedMs).toBeGreaterThanOrEqual(1_800)
    expect(elapsedMs).toBeLessThan(2_500)
    expect(await readFile(auditPath, 'utf8')).toBe('active-owner\n')
    expect(await readFile(lockPath, 'utf8')).toBe('other-lock-owner\n')
    expect(await readFile(generationPath, 'utf8')).toBe('generation-owner\n')
    expect(await readFile(legacyPath, 'utf8')).toBe('legacy-owner\n')
    expect(await readFile(unrelatedPath, 'utf8')).toBe('unrelated-owner\n')
  })
})
