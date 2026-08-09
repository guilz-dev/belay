import { mkdir, mkdtemp, readFile, readlink, rm, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'
import {
  applyObservedChanges,
  buildObservedChangesFromTransactional,
  TRANSACTIONAL_APPLY_TOCTOU,
} from '../core/transactional/apply-observed-changes.js'

const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

describe('apply observed changes', () => {
  it('applies directory, file, and symlink changes in order', async () => {
    const targetRoot = await mkdtemp(path.join(os.tmpdir(), 'belay-apply-target-'))
    const sourceRoot = await mkdtemp(path.join(os.tmpdir(), 'belay-apply-source-'))
    tempDirs.push(targetRoot, sourceRoot)

    await mkdir(path.join(sourceRoot, 'pkg'), { recursive: true })
    await writeFile(path.join(sourceRoot, 'pkg', 'file.txt'), 'new\n')
    await symlink('pkg/file.txt', path.join(sourceRoot, 'link'))

    const observed = await buildObservedChangesFromTransactional(targetRoot, sourceRoot, [
      { relativePath: 'pkg', kind: 'added' },
      { relativePath: 'pkg/file.txt', kind: 'added' },
      { relativePath: 'link', kind: 'added' },
    ])

    await applyObservedChanges({ sourceRoot, targetRoot, changes: observed })

    await expect(readFile(path.join(targetRoot, 'pkg', 'file.txt'), 'utf8')).resolves.toBe('new\n')
    await expect(readlink(path.join(targetRoot, 'link'))).resolves.toBe('pkg/file.txt')
  })

  it('rolls back all writes when a later step fails', async () => {
    const targetRoot = await mkdtemp(path.join(os.tmpdir(), 'belay-apply-rollback-'))
    const sourceRoot = await mkdtemp(path.join(os.tmpdir(), 'belay-apply-rollback-src-'))
    tempDirs.push(targetRoot, sourceRoot)

    await writeFile(path.join(targetRoot, 'keep.txt'), 'stay\n')
    await writeFile(path.join(sourceRoot, 'a.txt'), 'changed\n')
    await writeFile(path.join(sourceRoot, 'b.txt'), 'new\n')
    await mkdir(path.join(targetRoot, 'b.txt'))

    const observed = await buildObservedChangesFromTransactional(targetRoot, sourceRoot, [
      { relativePath: 'a.txt', kind: 'modified' },
      { relativePath: 'b.txt', kind: 'added' },
    ])

    await expect(
      applyObservedChanges({ sourceRoot, targetRoot, changes: observed }),
    ).rejects.toThrow()
    await expect(readFile(path.join(targetRoot, 'keep.txt'), 'utf8')).resolves.toBe('stay\n')
    await expect(readFile(path.join(targetRoot, 'a.txt'), 'utf8')).rejects.toThrow()
  })

  it('fails closed on concurrent target edits before the first write', async () => {
    const targetRoot = await mkdtemp(path.join(os.tmpdir(), 'belay-apply-toctou-'))
    const sourceRoot = await mkdtemp(path.join(os.tmpdir(), 'belay-apply-toctou-src-'))
    tempDirs.push(targetRoot, sourceRoot)

    await writeFile(path.join(targetRoot, 'a.txt'), 'original\n')
    await writeFile(path.join(sourceRoot, 'a.txt'), 'changed\n')

    const observed = await buildObservedChangesFromTransactional(targetRoot, sourceRoot, [
      { relativePath: 'a.txt', kind: 'modified' },
    ])
    await writeFile(path.join(targetRoot, 'a.txt'), 'raced\n')

    await expect(
      applyObservedChanges({ sourceRoot, targetRoot, changes: observed }),
    ).rejects.toThrow(TRANSACTIONAL_APPLY_TOCTOU)
    await expect(readFile(path.join(targetRoot, 'a.txt'), 'utf8')).resolves.toBe('raced\n')
  })

  it('does not roll back when afterApply cleanup fails after a verified apply', async () => {
    const targetRoot = await mkdtemp(path.join(os.tmpdir(), 'belay-apply-after-'))
    const sourceRoot = await mkdtemp(path.join(os.tmpdir(), 'belay-apply-after-src-'))
    tempDirs.push(targetRoot, sourceRoot)

    await writeFile(path.join(sourceRoot, 'a.txt'), 'changed\n')
    const observed = await buildObservedChangesFromTransactional(targetRoot, sourceRoot, [
      { relativePath: 'a.txt', kind: 'added' },
    ])

    await expect(
      applyObservedChanges({
        sourceRoot,
        targetRoot,
        changes: observed,
        afterApply: async () => {
          throw new Error('audit failed')
        },
      }),
    ).resolves.toBeUndefined()

    await expect(readFile(path.join(targetRoot, 'a.txt'), 'utf8')).resolves.toBe('changed\n')
  })
})
