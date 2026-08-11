import { execFile } from 'node:child_process'
import {
  chmod,
  link,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { createServer } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'

import { afterEach, describe, expect, it } from 'vitest'
import { cloneDirectoryTree, probeFileCloneStrategy } from '../core/transactional/file-clone.js'
import {
  buildFileTreeIndex,
  diffFileTreeIndices,
  FILE_CHECKPOINT_HARDLINK_UNSUPPORTED,
  FILE_CHECKPOINT_NESTED_REPOSITORY,
  FILE_CHECKPOINT_QUOTA_EXCEEDED,
  FILE_CHECKPOINT_UNSUPPORTED_NODE,
  readObservedChanges,
} from '../core/transactional/file-tree.js'
import { validateRelativePath } from '../core/transactional/file-tree-path.js'
import { readSnapshotNode } from '../core/transactional/snapshot-node.js'

const tempDirs: string[] = []
const execFileAsync = promisify(execFile)

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

  it('indexes directory symlinks without following them', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'belay-ftree-dirlink-'))
    tempDirs.push(root)
    await mkdir(path.join(root, 'real'), { recursive: true })
    await writeFile(path.join(root, 'real', 'inside.txt'), 'hidden\n')
    await symlink('real', path.join(root, 'link'))

    const index = await buildFileTreeIndex({ resourceRoot: root })
    const paths = index.entries.map((entry) => entry.relativePath)

    expect(paths).toContain('link')
    expect(paths).not.toContain('link/inside.txt')
    expect(paths).toContain('real/inside.txt')
    expect((await lstat(path.join(root, 'link'))).isSymbolicLink()).toBe(true)
  })

  it('excludes root git metadata and configured excluded roots', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'belay-ftree-exclude-'))
    const excluded = path.join(root, 'managed')
    tempDirs.push(root)
    await mkdir(path.join(root, '.git'), { recursive: true })
    await writeFile(path.join(root, '.git', 'HEAD'), 'ref: refs/heads/main\n')
    await mkdir(excluded, { recursive: true })
    await writeFile(path.join(excluded, 'secret.txt'), 'hidden\n')
    await writeFile(path.join(root, 'visible.txt'), 'ok\n')

    const index = await buildFileTreeIndex({ resourceRoot: root, excludedRoots: [excluded] })
    const paths = index.entries.map((entry) => entry.relativePath)

    expect(paths).toContain('visible.txt')
    expect(paths).not.toContain('.git')
    expect(paths).not.toContain('managed/secret.txt')
  })

  it('rejects hardlinks, fifos, and unix sockets', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'belay-ftree-unsupported-'))
    tempDirs.push(root)

    await writeFile(path.join(root, 'original.txt'), 'linked\n')
    await link(path.join(root, 'original.txt'), path.join(root, 'linked.txt'))
    await expect(buildFileTreeIndex({ resourceRoot: root })).rejects.toThrow(
      FILE_CHECKPOINT_HARDLINK_UNSUPPORTED,
    )

    const fifoRoot = await mkdtemp(path.join(os.tmpdir(), 'belay-ftree-fifo-'))
    tempDirs.push(fifoRoot)
    await execFileAsync('mkfifo', [path.join(fifoRoot, 'pipe')])
    await expect(buildFileTreeIndex({ resourceRoot: fifoRoot })).rejects.toThrow(
      FILE_CHECKPOINT_UNSUPPORTED_NODE,
    )

    const socketRoot = await mkdtemp(path.join(os.tmpdir(), 'belay-ftree-socket-'))
    tempDirs.push(socketRoot)
    const socketPath = path.join(socketRoot, 'service.sock')
    const server = createServer()
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(socketPath, resolve)
    })
    try {
      await expect(buildFileTreeIndex({ resourceRoot: socketRoot })).rejects.toThrow(
        FILE_CHECKPOINT_UNSUPPORTED_NODE,
      )
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()))
      })
    }
  })

  it('reads observed changes for an explicit path list', async () => {
    const baselineRoot = await mkdtemp(path.join(os.tmpdir(), 'belay-ftree-base-'))
    const executionRoot = await mkdtemp(path.join(os.tmpdir(), 'belay-ftree-exec-'))
    tempDirs.push(baselineRoot, executionRoot)
    await writeFile(path.join(baselineRoot, 'a.txt'), 'before\n')
    await writeFile(path.join(executionRoot, 'a.txt'), 'after\n')

    const changes = await readObservedChanges(baselineRoot, executionRoot, ['a.txt'])
    expect(changes).toHaveLength(1)
    expect(changes[0]?.kind).toBe('modified')
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

  it('round-trips empty directories through cloneDirectoryTree', async () => {
    const source = await mkdtemp(path.join(os.tmpdir(), 'belay-fclone-empty-src-'))
    const destination = await mkdtemp(path.join(os.tmpdir(), 'belay-fclone-empty-dst-'))
    tempDirs.push(source, destination)
    await mkdir(path.join(source, 'empty'), { recursive: true })

    await cloneDirectoryTree(source, destination)
    const baseline = await buildFileTreeIndex({ resourceRoot: source })
    const cloned = await buildFileTreeIndex({ resourceRoot: destination })

    expect(diffFileTreeIndices(baseline, cloned)).toEqual([])
    const emptyInfo = await lstat(path.join(destination, 'empty'))
    expect(emptyInfo.isDirectory()).toBe(true)
  })

  it('round-trips executable modes and spaced filenames', async () => {
    const source = await mkdtemp(path.join(os.tmpdir(), 'belay-fclone-modes-src-'))
    const destination = await mkdtemp(path.join(os.tmpdir(), 'belay-fclone-modes-dst-'))
    tempDirs.push(source, destination)
    await mkdir(path.join(source, 'dir'), { recursive: true })
    await writeFile(path.join(source, 'dir', ' spaced.txt '), 'hello\n', { mode: 0o644 })
    await chmod(path.join(source, 'dir', ' spaced.txt '), 0o755)
    await writeFile(path.join(source, 'exec.sh'), '#!/bin/sh\n', { mode: 0o755 })

    await cloneDirectoryTree(source, destination)

    const spaced = await lstat(path.join(destination, 'dir', ' spaced.txt '))
    const executable = await lstat(path.join(destination, 'exec.sh'))
    expect(spaced.mode & 0o777).toBe(0o755)
    expect(executable.mode & 0o777).toBe(0o755)
    await expect(readFile(path.join(destination, 'dir', ' spaced.txt '), 'utf8')).resolves.toBe(
      'hello\n',
    )
  })

  it('probes clonefile or copy support', async () => {
    await expect(probeFileCloneStrategy()).resolves.toMatch(/^(clonefile|copy)$/)
  })

  it('clones many files with bounded copyConcurrency', async () => {
    const source = await mkdtemp(path.join(os.tmpdir(), 'belay-fclone-conc-src-'))
    const destination = await mkdtemp(path.join(os.tmpdir(), 'belay-fclone-conc-dst-'))
    tempDirs.push(source, destination)
    for (let index = 0; index < 24; index += 1) {
      await writeFile(path.join(source, `file-${index}.txt`), `payload-${index}\n`)
    }

    const result = await cloneDirectoryTree(source, destination, {
      quotas: {
        maxFiles: 100,
        maxSourceBytes: 10_000_000,
        maxWorkspaceBytes: 20_000_000,
        prepareTimeoutMs: 30_000,
        copyConcurrency: 4,
      },
    })
    expect(result.sourceIndex.fileCount).toBe(24)
    await expect(readFile(path.join(destination, 'file-12.txt'), 'utf8')).resolves.toBe(
      'payload-12\n',
    )
  })
})
