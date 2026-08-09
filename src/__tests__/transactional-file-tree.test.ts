import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'
import { cloneDirectoryTree } from '../core/transactional/file-clone.js'
import {
  buildFileTreeIndex,
  diffFileTreeIndices,
  FILE_CHECKPOINT_NESTED_REPOSITORY,
  FILE_CHECKPOINT_QUOTA_EXCEEDED,
} from '../core/transactional/file-tree.js'
import { validateRelativePath } from '../core/transactional/file-tree-path.js'
import { readSnapshotNode } from '../core/transactional/snapshot-node.js'

const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

describe('transactional file tree', () => {
  it('indexes files, directories, symlinks, and spaced filenames', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'belay-ftree-'))
    tempDirs.push(root)
    await mkdir(path.join(root, 'dir'), { recursive: true })
    await writeFile(path.join(root, 'dir', ' spaced.txt '), 'hello\n', { mode: 0o644 })
    await chmod(path.join(root, 'dir', ' spaced.txt '), 0o755)
    await writeFile(path.join(root, 'exec.sh'), '#!/bin/sh\n', { mode: 0o755 })
    await symlink('dir/ spaced.txt ', path.join(root, 'link'))

    const index = await buildFileTreeIndex({ resourceRoot: root })
    const paths = index.entries.map((entry) => entry.relativePath).sort()

    expect(paths).toEqual(['dir', 'dir/ spaced.txt ', 'exec.sh', 'link'])
    expect(index.fileCount).toBeGreaterThanOrEqual(3)
    expect(index.directoryCount).toBe(1)
  })

  it('detects content changes when size and mtime are preserved', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'belay-ftree-diff-'))
    tempDirs.push(root)
    const filePath = path.join(root, 'same-size.txt')
    await writeFile(filePath, 'aaaa\n')
    const baseline = await buildFileTreeIndex({ resourceRoot: root })

    await writeFile(filePath, 'bbbb\n')
    const observed = await buildFileTreeIndex({ resourceRoot: root })
    const changes = diffFileTreeIndices(baseline, observed)

    expect(changes).toHaveLength(1)
    expect(changes[0]?.relativePath).toBe('same-size.txt')
    expect(changes[0]?.kind).toBe('modified')
  })

  it('rejects nested git metadata and path escape', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'belay-ftree-git-'))
    tempDirs.push(root)
    await mkdir(path.join(root, 'pkg', '.git'), { recursive: true })

    await expect(buildFileTreeIndex({ resourceRoot: root })).rejects.toThrow(
      FILE_CHECKPOINT_NESTED_REPOSITORY,
    )
    expect(() => validateRelativePath('../escape')).toThrow()
  })

  it('enforces file quotas during indexing', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'belay-ftree-quota-'))
    tempDirs.push(root)
    await writeFile(path.join(root, 'a.txt'), 'a\n')
    await writeFile(path.join(root, 'b.txt'), 'b\n')

    await expect(
      buildFileTreeIndex({
        resourceRoot: root,
        quotas: { maxFiles: 1, maxSourceBytes: 1024, prepareTimeoutMs: 30_000 },
      }),
    ).rejects.toThrow(FILE_CHECKPOINT_QUOTA_EXCEEDED)
  })
})

describe('transactional file clone', () => {
  it('round-trips a tree through cloneDirectoryTree', async () => {
    const source = await mkdtemp(path.join(os.tmpdir(), 'belay-fclone-src-'))
    const destination = await mkdtemp(path.join(os.tmpdir(), 'belay-fclone-dst-'))
    tempDirs.push(source, destination)
    await mkdir(path.join(source, 'nested'), { recursive: true })
    await writeFile(path.join(source, 'nested', 'file.txt'), 'payload\n', { mode: 0o644 })
    await symlink('nested/file.txt', path.join(source, 'alias'))

    const result = await cloneDirectoryTree(source, destination)
    const baseline = await buildFileTreeIndex({ resourceRoot: source })
    const cloned = await buildFileTreeIndex({ resourceRoot: destination })

    expect(diffFileTreeIndices(baseline, cloned)).toEqual([])
    expect(['clonefile', 'copy']).toContain(result.strategy)
    await expect(readFile(path.join(destination, 'nested', 'file.txt'), 'utf8')).resolves.toBe(
      'payload\n',
    )
    await expect(readSnapshotNode(path.join(destination, 'alias'))).resolves.toMatchObject({
      kind: 'symlink',
    })
  })
})
