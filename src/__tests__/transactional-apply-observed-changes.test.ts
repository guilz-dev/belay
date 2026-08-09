import { lstat, mkdir, mkdtemp, readFile, readlink, rm, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'
import {
  applyObservedChanges,
  buildObservedChangesFromTransactional,
  TRANSACTIONAL_APPLY_CONFLICT,
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

  it('rejects apply when a parent path component is a symlink', async () => {
    const targetRoot = await mkdtemp(path.join(os.tmpdir(), 'belay-apply-parent-link-'))
    const sourceRoot = await mkdtemp(path.join(os.tmpdir(), 'belay-apply-parent-link-src-'))
    tempDirs.push(targetRoot, sourceRoot)

    await writeFile(path.join(targetRoot, 'link'), 'not-a-directory\n')
    await symlink('link', path.join(targetRoot, 'alias'))

    const observed = [
      {
        relativePath: 'alias/child.txt',
        kind: 'added' as const,
        before: { kind: 'absent' as const },
        after: { kind: 'file' as const, mode: 0o644, size: 4, hash: 'unused' },
      },
    ]

    await expect(
      applyObservedChanges({ sourceRoot, targetRoot, changes: observed }),
    ).rejects.toThrow(TRANSACTIONAL_APPLY_CONFLICT)
  })

  it('applies file to symlink type changes and empty directory lifecycle', async () => {
    const targetRoot = await mkdtemp(path.join(os.tmpdir(), 'belay-apply-types-'))
    const sourceRoot = await mkdtemp(path.join(os.tmpdir(), 'belay-apply-types-src-'))
    tempDirs.push(targetRoot, sourceRoot)

    await writeFile(path.join(targetRoot, 'node'), 'plain\n')
    await symlink('node', path.join(sourceRoot, 'node'))
    await mkdir(path.join(sourceRoot, 'empty'), { recursive: true })

    const typeChange = await buildObservedChangesFromTransactional(targetRoot, sourceRoot, [
      { relativePath: 'node', kind: 'modified' },
    ])
    await applyObservedChanges({ sourceRoot, targetRoot, changes: typeChange })
    await expect(readlink(path.join(targetRoot, 'node'))).resolves.toBe('node')

    const addEmpty = await buildObservedChangesFromTransactional(targetRoot, sourceRoot, [
      { relativePath: 'empty', kind: 'added' },
    ])
    await applyObservedChanges({ sourceRoot, targetRoot, changes: addEmpty })
    expect((await lstat(path.join(targetRoot, 'empty'))).isDirectory()).toBe(true)

    await rm(path.join(sourceRoot, 'empty'), { recursive: true })
    const removeEmpty = await buildObservedChangesFromTransactional(targetRoot, sourceRoot, [
      { relativePath: 'empty', kind: 'deleted' },
    ])
    await applyObservedChanges({ sourceRoot, targetRoot, changes: removeEmpty })
    await expect(lstat(path.join(targetRoot, 'empty'))).rejects.toThrow()
  })

  it('updates directory mode when only permissions change', async () => {
    const targetRoot = await mkdtemp(path.join(os.tmpdir(), 'belay-apply-dir-mode-'))
    const sourceRoot = await mkdtemp(path.join(os.tmpdir(), 'belay-apply-dir-mode-src-'))
    tempDirs.push(targetRoot, sourceRoot)

    await mkdir(path.join(targetRoot, 'pkg'), { mode: 0o755 })
    await mkdir(path.join(sourceRoot, 'pkg'), { mode: 0o700 })

    const observed = await buildObservedChangesFromTransactional(targetRoot, sourceRoot, [
      { relativePath: 'pkg', kind: 'modified' },
    ])

    await applyObservedChanges({ sourceRoot, targetRoot, changes: observed })
    const info = await lstat(path.join(targetRoot, 'pkg'))
    expect(info.mode & 0o777).toBe(0o700)
  })

  it('rolls back when post-apply verification fails', async () => {
    const targetRoot = await mkdtemp(path.join(os.tmpdir(), 'belay-apply-post-verify-'))
    const sourceRoot = await mkdtemp(path.join(os.tmpdir(), 'belay-apply-post-verify-src-'))
    tempDirs.push(targetRoot, sourceRoot)

    await writeFile(path.join(targetRoot, 'a.txt'), 'original\n')
    await writeFile(path.join(sourceRoot, 'a.txt'), 'changed\n')
    const observed = await buildObservedChangesFromTransactional(targetRoot, sourceRoot, [
      { relativePath: 'a.txt', kind: 'modified' },
    ])
    const first = observed[0]
    expect(first).toBeDefined()
    if (first) {
      first.after = { kind: 'file', mode: 0o644, size: 999, hash: 'mismatch' }
    }

    await expect(
      applyObservedChanges({ sourceRoot, targetRoot, changes: observed }),
    ).rejects.toThrow(TRANSACTIONAL_APPLY_CONFLICT)
    await expect(readFile(path.join(targetRoot, 'a.txt'), 'utf8')).resolves.toBe('original\n')
  })

  it('deletes nested directories child-first', async () => {
    const targetRoot = await mkdtemp(path.join(os.tmpdir(), 'belay-apply-delete-'))
    const sourceRoot = await mkdtemp(path.join(os.tmpdir(), 'belay-apply-delete-src-'))
    tempDirs.push(targetRoot, sourceRoot)

    await mkdir(path.join(targetRoot, 'pkg'), { recursive: true })
    await writeFile(path.join(targetRoot, 'pkg', 'file.txt'), 'gone\n')

    const observed = await buildObservedChangesFromTransactional(targetRoot, sourceRoot, [
      { relativePath: 'pkg/file.txt', kind: 'deleted' },
      { relativePath: 'pkg', kind: 'deleted' },
    ])

    await applyObservedChanges({ sourceRoot, targetRoot, changes: observed })
    await expect(lstat(path.join(targetRoot, 'pkg'))).rejects.toThrow()
  })
})
