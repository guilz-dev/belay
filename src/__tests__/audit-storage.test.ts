import { createHash } from 'node:crypto'
import {
  type FileHandle,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readdir,
  readFile,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'

import { afterEach, describe, expect, it } from 'vitest'
import { appendAuditRecord } from '../core/audit-serialize.js'
import {
  appendBoundedAuditLine,
  iterateAuditRecords,
  loadRetainedAuditRecords,
} from '../core/audit-storage.js'
import { DEFAULT_REDACTION_V3 } from '../core/config.js'

const tempDirs: string[] = []
const FIXED_MAX_AUDIT_RECORD_BYTES = 33_554_432

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

async function expectRetainedContents(auditPath: string, contents: string[]): Promise<void> {
  for (const [index, content] of contents.entries()) {
    const retainedPath = index === 0 ? auditPath : `${auditPath}.${index}`
    expect(await readFile(retainedPath, 'utf8')).toBe(content)
  }
  expect((await readdir(path.dirname(auditPath))).sort()).toEqual(
    contents.map((_, index) => (index === 0 ? 'audit.ndjson' : `audit.ndjson.${index}`)).sort(),
  )
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

  it('rotates before append with .1 newest and removes excess numeric generations', async () => {
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
    await expectMissing(outsideRetentionPath)
    expect(await readFile(legacyPath, 'utf8')).toBe('legacy\n')
    expect(await readFile(unrelatedPath, 'utf8')).toBe('unrelated\n')
  })

  it('prunes excess numeric generations on a normal appendAuditRecord path', async () => {
    const auditPath = await createAuditPath('belay-audit-storage-shrink-')
    const legacyPath = `${auditPath}.legacy-20260908T000000Z.ndjson`
    const unrelatedPath = path.join(path.dirname(auditPath), 'notes.txt')
    await writeFile(auditPath, '{"event":"active"}\n', 'utf8')
    for (let generation = 1; generation <= 4; generation += 1) {
      await writeFile(`${auditPath}.${generation}`, `{"event":"old-${generation}"}\n`, 'utf8')
    }
    await writeFile(legacyPath, 'legacy\n', 'utf8')
    await writeFile(unrelatedPath, 'unrelated\n', 'utf8')

    await appendAuditRecord(auditPath, { event: 'next' }, DEFAULT_REDACTION_V3, {
      maxBytes: 1_048_576,
      maxFiles: 3,
    })

    await expectMissing(`${auditPath}.3`)
    await expectMissing(`${auditPath}.4`)
    expect(await readFile(`${auditPath}.1`, 'utf8')).toContain('old-1')
    expect(await readFile(`${auditPath}.2`, 'utf8')).toContain('old-2')
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

    const loaded = await loadRetainedAuditRecords({
      auditPath,
      maxFiles: 2,
      maxLineBytes: FIXED_MAX_AUDIT_RECORD_BYTES,
    })
    expect(loaded.records.map((record) => record.fingerprint)).toEqual(['first', 'oversized'])
    expect(loaded.diagnostics.oversizedLines).toBe(0)
  })

  it('rejects a complete line above the fixed record ceiling before creating storage', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'belay-audit-storage-record-bound-'))
    tempDirs.push(root)
    const auditPath = path.join(root, 'not-created', 'audit.ndjson')
    const line = `"${'x'.repeat(FIXED_MAX_AUDIT_RECORD_BYTES)}"`

    await expect(
      appendBoundedAuditLine({
        auditPath,
        line,
        maxBytes: FIXED_MAX_AUDIT_RECORD_BYTES * 2,
        maxFiles: 2,
      }),
    ).rejects.toThrow(/audit record.*33554432/i)

    await expectMissing(path.dirname(auditPath))
  })

  it('preserves the maxFiles=1 active file when staging open fails', async () => {
    const auditPath = await createAuditPath('belay-audit-storage-open-rollback-')
    await writeFile(auditPath, 'active-before\n', 'utf8')
    let failed = false

    await expect(
      appendBoundedAuditLine(
        {
          auditPath,
          line: rotatingLine('not-committed'),
          maxBytes: 1,
          maxFiles: 1,
        },
        {
          async open(filePath, flags, mode) {
            if (!failed && !filePath.toString().endsWith('.lock')) {
              failed = true
              throw Object.assign(new Error('injected audit storage open failure'), { code: 'EIO' })
            }
            return open(filePath, flags, mode)
          },
        },
      ),
    ).rejects.toThrow(/injected audit storage open failure/)

    await expectRetainedContents(auditPath, ['active-before\n'])
  })

  it('preserves every generation when staging write fails before rotation', async () => {
    const auditPath = await createAuditPath('belay-audit-storage-write-rollback-')
    const before = ['active-before\n', 'generation-one\n', 'generation-two\n']
    await Promise.all(
      before.map((content, index) =>
        writeFile(index === 0 ? auditPath : `${auditPath}.${index}`, content, 'utf8'),
      ),
    )

    await expect(
      appendBoundedAuditLine(
        {
          auditPath,
          line: rotatingLine('not-committed'),
          maxBytes: 1,
          maxFiles: 3,
        },
        {
          async write() {
            throw Object.assign(new Error('injected audit storage write failure'), { code: 'EIO' })
          },
        },
      ),
    ).rejects.toThrow(/injected audit storage write failure/)

    await expectRetainedContents(auditPath, before)
  })

  it('restores the maxFiles=1 active file when committing the staged record fails', async () => {
    const auditPath = await createAuditPath('belay-audit-storage-one-file-rollback-')
    await writeFile(auditPath, 'active-before\n', 'utf8')
    let failed = false

    await expect(
      appendBoundedAuditLine(
        {
          auditPath,
          line: rotatingLine('not-committed'),
          maxBytes: 1,
          maxFiles: 1,
        },
        {
          async rename(sourcePath, destinationPath) {
            if (!failed && destinationPath.toString() === path.resolve(auditPath)) {
              failed = true
              throw Object.assign(new Error('injected audit storage rename failure'), {
                code: 'EIO',
              })
            }
            await rename(sourcePath, destinationPath)
          },
        },
      ),
    ).rejects.toThrow(/injected audit storage rename failure/)

    await expectRetainedContents(auditPath, ['active-before\n'])
  })

  it('rolls back a partially shifted multi-generation rotation', async () => {
    const auditPath = await createAuditPath('belay-audit-storage-generation-rollback-')
    const before = ['active-before\n', 'generation-one\n', 'generation-two\n', 'generation-three\n']
    await Promise.all(
      before.map((content, index) =>
        writeFile(index === 0 ? auditPath : `${auditPath}.${index}`, content, 'utf8'),
      ),
    )
    let renameCalls = 0

    await expect(
      appendBoundedAuditLine(
        {
          auditPath,
          line: rotatingLine('not-committed'),
          maxBytes: 1,
          maxFiles: 4,
        },
        {
          async rename(sourcePath, destinationPath) {
            renameCalls += 1
            if (renameCalls === 2) {
              throw Object.assign(new Error('injected audit storage rename failure'), {
                code: 'EIO',
              })
            }
            await rename(sourcePath, destinationPath)
          },
        },
      ),
    ).rejects.toThrow(/injected audit storage rename failure/)

    await expectRetainedContents(auditPath, before)
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

  it.each([
    101,
    100.5,
    Number.MAX_SAFE_INTEGER,
    Number.MAX_SAFE_INTEGER + 1,
    Number.POSITIVE_INFINITY,
  ])('rejects an out-of-range direct maxFiles value before touching storage: %s', async (maxFiles) => {
    const auditPath = await createAuditPath('belay-audit-storage-max-files-')

    await expect(
      appendBoundedAuditLine({
        auditPath,
        line: rotatingLine('invalid-bound'),
        maxBytes: 128,
        maxFiles,
      }),
    ).rejects.toThrow(/audit maxFiles/i)

    await expectMissing(auditPath)
    await expectMissing(`${auditPath}.lock`)
  })
})

describe('retained audit reads', () => {
  it('keeps a minimal availability watermark until the decision cohort changes', async () => {
    const auditPath = await createAuditPath('belay-audit-storage-readiness-watermark-')
    const cohortA = {
      runtimeArtifactHash: 'a'.repeat(64),
      decisionConfigFingerprint: 'b'.repeat(64),
      boundaryProfile: 'l3-l4-only',
    }
    const cohortB = {
      runtimeArtifactHash: 'c'.repeat(64),
      decisionConfigFingerprint: 'd'.repeat(64),
      boundaryProfile: 'l3-l4-only',
    }

    await appendAuditRecord(
      auditPath,
      {
        timestamp: '2026-09-08T01:00:00.000Z',
        event: 'beforeShellExecution',
        kind: 'shell',
        verdict: 'deny_pending_approval',
        reason: 'missing_trusted_cwd',
        wouldBlock: true,
        summary: 'private command and cwd must not enter the watermark',
        ...cohortA,
      },
      DEFAULT_REDACTION_V3,
      { maxBytes: 512, maxFiles: 1 },
    )

    const blocked = await loadRetainedAuditRecords({
      auditPath,
      maxFiles: 1,
      maxLineBytes: FIXED_MAX_AUDIT_RECORD_BYTES,
    })
    const blockedState = blocked.readinessState
    expect(blockedState).toMatchObject({
      status: 'valid',
      state: {
        cohort: {
          runtimeArtifactHash: cohortA.runtimeArtifactHash,
          decisionConfigFingerprint: cohortA.decisionConfigFingerprint,
          boundaryFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
        },
        availabilityAskCount: 1,
      },
    })
    const serializedState = await readFile(`${auditPath}.readiness.json`, 'utf8')
    expect(serializedState).not.toContain('private command')
    expect(serializedState).not.toContain('cwd')

    await appendAuditRecord(
      auditPath,
      {
        timestamp: '2026-09-08T01:01:00.000Z',
        event: 'beforeShellExecution',
        kind: 'shell',
        verdict: 'allow',
        reason: 'read_only',
        wouldBlock: false,
        ...cohortB,
      },
      DEFAULT_REDACTION_V3,
      { maxBytes: 512, maxFiles: 1 },
    )

    const reset = await loadRetainedAuditRecords({
      auditPath,
      maxFiles: 1,
      maxLineBytes: FIXED_MAX_AUDIT_RECORD_BYTES,
    })
    expect(reset.readinessState).toMatchObject({
      status: 'valid',
      state: {
        cohort: { runtimeArtifactHash: cohortB.runtimeArtifactHash },
        availabilityAskCount: 0,
      },
    })
  })

  it('iterates only exact retained generations oldest-to-active across gaps', async () => {
    const auditPath = await createAuditPath('belay-audit-storage-read-order-')
    const recordsByPath = new Map([
      [`${auditPath}.4`, { marker: 'oldest' }],
      [`${auditPath}.2`, { marker: 'middle' }],
      [auditPath, { marker: 'active' }],
      [`${auditPath}.5`, { marker: 'outside-retention' }],
      [`${auditPath}.legacy-20260908T000000Z.ndjson`, { marker: 'legacy-archive' }],
    ])
    await Promise.all(
      [...recordsByPath].map(([filePath, record]) =>
        writeFile(filePath, `${JSON.stringify(record)}\n`, 'utf8'),
      ),
    )

    const markers: unknown[] = []
    for await (const record of iterateAuditRecords({
      auditPath,
      maxFiles: 5,
      maxLineBytes: 256,
    })) {
      markers.push(record.marker)
    }

    expect(markers).toEqual(['oldest', 'middle', 'active'])
  })

  it('collects exact diagnostics while blanks and invalid rows contribute no evidence', async () => {
    const auditPath = await createAuditPath('belay-audit-storage-read-diagnostics-')
    const oldest = `${JSON.stringify({ marker: 'oldest' })}\n\n{malformed\n`
    const middle = `"private-non-object"\n${JSON.stringify({ marker: 'middle' })}\r\n`
    const oversized = JSON.stringify({ marker: 'private-oversized', padding: 'x'.repeat(200) })
    const active = ` \t\n${oversized}\n${JSON.stringify({ marker: 'active' })}\n`
    await writeFile(`${auditPath}.2`, oldest, 'utf8')
    await writeFile(`${auditPath}.1`, middle, 'utf8')
    await writeFile(auditPath, active, 'utf8')

    const result = await loadRetainedAuditRecords({
      auditPath,
      maxFiles: 3,
      maxLineBytes: 80,
    })

    expect(result.records.map((record) => record.marker)).toEqual(['oldest', 'middle', 'active'])
    expect(result.diagnostics).toEqual({
      filesRead: 3,
      bytesRead:
        Buffer.byteLength(oldest, 'utf8') +
        Buffer.byteLength(middle, 'utf8') +
        Buffer.byteLength(active, 'utf8'),
      parsedRecords: 3,
      malformedLines: 2,
      oversizedLines: 1,
    })
    expect(JSON.stringify(result)).not.toContain('private-non-object')
    expect(JSON.stringify(result)).not.toContain('private-oversized')
  })

  it('frames LF, CRLF, split UTF-8, discarded oversized rows, and an unterminated final row', async () => {
    const auditPath = await createAuditPath('belay-audit-storage-read-chunks-')
    await writeFile(auditPath, `${JSON.stringify({ marker: 'disk-placeholder' })}\n`, 'utf8')
    const crlf = Buffer.from(`${JSON.stringify({ marker: 'crlf' })}\r\n`, 'utf8')
    const multibyte = Buffer.from(`${JSON.stringify({ marker: '雪' })}\n`, 'utf8')
    const snowStart = multibyte.indexOf(Buffer.from('雪', 'utf8'))
    const chunks = [
      Buffer.from('\n', 'utf8'),
      crlf.subarray(0, crlf.length - 1),
      crlf.subarray(crlf.length - 1),
      multibyte.subarray(0, snowStart + 1),
      multibyte.subarray(snowStart + 1),
      Buffer.from('x'.repeat(41), 'utf8'),
      Buffer.from('private-discarded-tail', 'utf8'),
      Buffer.from('\n \t\r\n', 'utf8'),
      Buffer.from(JSON.stringify({ marker: 'final' }), 'utf8'),
    ]

    const result = await loadRetainedAuditRecords(
      { auditPath, maxFiles: 1, maxLineBytes: 40 },
      {
        createReadStream() {
          return Readable.from(chunks, { objectMode: false })
        },
      },
    )

    expect(result.records.map((record) => record.marker)).toEqual(['crlf', '雪', 'final'])
    expect(result.diagnostics).toEqual({
      filesRead: 1,
      bytesRead: chunks.reduce((total, chunk) => total + chunk.length, 0),
      parsedRecords: 3,
      malformedLines: 0,
      oversizedLines: 1,
    })
    expect(JSON.stringify(result)).not.toContain('private-discarded-tail')
  })

  it('rejects a mid-read stream error and closes the opened file handle', async () => {
    const auditPath = await createAuditPath('belay-audit-storage-read-stream-error-')
    await writeFile(auditPath, `${JSON.stringify({ marker: 'disk-placeholder' })}\n`, 'utf8')
    const injectedError = Object.assign(new Error('injected retained audit stream failure'), {
      code: 'EIO',
    })
    let openedHandle: FileHandle | undefined

    async function* erroringChunks(): AsyncGenerator<Buffer> {
      yield Buffer.from(`${JSON.stringify({ marker: 'before-error' })}\n`, 'utf8')
      throw injectedError
    }

    await expect(
      loadRetainedAuditRecords(
        { auditPath, maxFiles: 1, maxLineBytes: 256 },
        {
          createReadStream(_filePath, handle) {
            openedHandle = handle
            return Readable.from(erroringChunks(), { objectMode: false })
          },
        },
      ),
    ).rejects.toBe(injectedError)

    if (!openedHandle) {
      throw new Error('injected stream factory did not receive the opened audit handle')
    }
    await expect(openedHandle.stat()).rejects.toMatchObject({ code: 'EBADF' })
  })

  it('reads a fixed generation snapshot when rotation starts during streaming', async () => {
    const auditPath = await createAuditPath('belay-audit-storage-read-rotation-race-')
    await writeFile(`${auditPath}.1`, `${JSON.stringify({ marker: 'oldest' })}\n`, 'utf8')
    await writeFile(auditPath, `${JSON.stringify({ marker: 'middle' })}\n`, 'utf8')
    let rotated = false

    const result = await loadRetainedAuditRecords(
      { auditPath, maxFiles: 3, maxLineBytes: 256 },
      {
        createReadStream(_filePath, handle) {
          async function* chunks(): AsyncGenerator<Buffer> {
            const bytes = await handle.readFile()
            if (!rotated) {
              rotated = true
              await appendBoundedAuditLine({
                auditPath,
                line: JSON.stringify({ marker: 'new' }),
                maxBytes: 1,
                maxFiles: 3,
              })
            }
            yield bytes
          }
          return Readable.from(chunks(), { objectMode: false })
        },
      },
    )

    expect(rotated).toBe(true)
    expect(result.records.map((record) => record.marker)).toEqual(['oldest', 'middle'])
  })

  it('closes fixed snapshot handles when an iterator consumer stops early', async () => {
    const auditPath = await createAuditPath('belay-audit-storage-read-cancel-')
    await writeFile(`${auditPath}.1`, `${JSON.stringify({ marker: 'oldest' })}\n`, 'utf8')
    await writeFile(auditPath, `${JSON.stringify({ marker: 'active' })}\n`, 'utf8')
    let streamedHandle: FileHandle | undefined

    for await (const _record of iterateAuditRecords(
      { auditPath, maxFiles: 2, maxLineBytes: 256 },
      {
        createReadStream(_filePath, handle) {
          streamedHandle = handle
          async function* chunks(): AsyncGenerator<Buffer> {
            yield await handle.readFile()
          }
          return Readable.from(chunks(), { objectMode: false })
        },
      },
    )) {
      break
    }

    if (!streamedHandle) throw new Error('stream factory did not receive a retained handle')
    await expect(streamedHandle.stat()).rejects.toMatchObject({ code: 'EBADF' })
  })

  it('refuses a retained-generation symlink without reading its target', async () => {
    const auditPath = await createAuditPath('belay-audit-storage-read-symlink-')
    const externalPath = path.join(path.dirname(auditPath), 'private-external.ndjson')
    const external = `${JSON.stringify({ marker: 'private-symlink-target' })}\n`
    await writeFile(externalPath, external, 'utf8')
    await symlink(externalPath, `${auditPath}.1`)
    await writeFile(auditPath, `${JSON.stringify({ marker: 'active' })}\n`, 'utf8')

    await expect(
      loadRetainedAuditRecords({ auditPath, maxFiles: 2, maxLineBytes: 256 }),
    ).rejects.toThrow(/symbolic link/i)
    expect(await readFile(externalPath, 'utf8')).toBe(external)
  })

  it('surfaces non-missing read errors instead of treating them as an empty audit', async () => {
    const auditPath = await createAuditPath('belay-audit-storage-read-error-')
    await mkdir(auditPath)

    await expect(
      loadRetainedAuditRecords({ auditPath, maxFiles: 1, maxLineBytes: 256 }),
    ).rejects.toThrow(/regular file/i)
  })

  it.each([
    [{ maxFiles: 0, maxLineBytes: 256 }, /maxFiles/i],
    [{ maxFiles: 1.5, maxLineBytes: 256 }, /maxFiles/i],
    [{ maxFiles: 101, maxLineBytes: 256 }, /maxFiles/i],
    [{ maxFiles: 1, maxLineBytes: 0 }, /maxLineBytes/i],
    [{ maxFiles: 1, maxLineBytes: 1.5 }, /maxLineBytes/i],
    [{ maxFiles: 1, maxLineBytes: FIXED_MAX_AUDIT_RECORD_BYTES + 1 }, /maxLineBytes/i],
  ])('rejects invalid read bounds before touching storage: %j', async (bounds, message) => {
    const auditPath = await createAuditPath('belay-audit-storage-invalid-read-bound-')

    await expect(loadRetainedAuditRecords({ auditPath, ...bounds })).rejects.toThrow(message)
    await expectMissing(auditPath)
  })
})
