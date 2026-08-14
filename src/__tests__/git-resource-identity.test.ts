import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import {
  inspectGitResourceIdentity,
  isGitMetadataPath,
  resolveGitResourceIdentity,
  sameGitResourceIdentity,
} from '../core/git-resource-identity.js'
import { canonicalPath } from '../core/path-utils.js'
import {
  createRealBareRepository,
  createRealGitRepository,
  createRealLinkedWorktree,
  initializeRealBareRepository,
  initializeRealGitRepository,
} from './helpers/git-fixtures.js'

const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

describe('Git resource identity', () => {
  it('resolves a normal repository from nested and not-yet-created targets', async () => {
    const repositoryRoot = await createRealGitRepository(tempDirs, 'belay-git-identity-main-')
    const nested = path.join(repositoryRoot, 'src', 'nested')
    await mkdir(nested, { recursive: true })

    const identity = resolveGitResourceIdentity(path.join(nested, 'new', 'file.ts'))

    expect(identity).toEqual({
      repositoryRoot: canonicalPath(repositoryRoot),
      gitDir: canonicalPath(path.join(repositoryRoot, '.git')),
      commonDir: canonicalPath(path.join(repositoryRoot, '.git')),
      gitEntryPath: canonicalPath(path.join(repositoryRoot, '.git')),
    })
  })

  it('uses canonical common-dir equality for a standard linked worktree', async () => {
    const repositoryRoot = await createRealGitRepository(
      tempDirs,
      'belay-git-identity-linked-main-',
    )
    const linkedRoot = `${repositoryRoot}-linked`
    await createRealLinkedWorktree(tempDirs, repositoryRoot, linkedRoot, 'linked')

    const linkedIdentity = resolveGitResourceIdentity(
      path.join(linkedRoot, 'nested', 'new-file.ts'),
    )

    expect(linkedIdentity).toMatchObject({
      repositoryRoot: canonicalPath(linkedRoot),
      commonDir: canonicalPath(path.join(repositoryRoot, '.git')),
    })
    expect(sameGitResourceIdentity(repositoryRoot, linkedRoot)).toBe(true)
  })

  it('recognizes a Belay transactional-style linked worktree', async () => {
    const repositoryRoot = await createRealGitRepository(
      tempDirs,
      'belay-git-identity-transaction-main-',
    )
    const transactionalRoot = `${repositoryRoot}-belay-transaction-worktree`
    await createRealLinkedWorktree(tempDirs, repositoryRoot, transactionalRoot, 'belay-tx-1')

    expect(sameGitResourceIdentity(repositoryRoot, transactionalRoot)).toBe(true)
    expect(resolveGitResourceIdentity(transactionalRoot)?.commonDir).toBe(
      canonicalPath(path.join(repositoryRoot, '.git')),
    )
  })

  it('keeps a separate repository outside even when nested under the workspace', async () => {
    const repositoryRoot = await createRealGitRepository(tempDirs, 'belay-git-identity-parent-')
    const separateRoot = path.join(repositoryRoot, 'vendor', 'separate')
    await mkdir(separateRoot, { recursive: true })
    await initializeRealGitRepository(separateRoot)

    expect(sameGitResourceIdentity(repositoryRoot, separateRoot)).toBe(false)
  })

  it('fails closed for malformed linked-worktree metadata', async () => {
    const repositoryRoot = await createRealGitRepository(
      tempDirs,
      'belay-git-identity-malformed-main-',
    )
    const malformedRoot = path.join(repositoryRoot, 'malformed')
    await mkdir(malformedRoot)
    await writeFile(path.join(malformedRoot, '.git'), 'not-a-gitdir-record\n')

    expect(resolveGitResourceIdentity(path.join(malformedRoot, 'new-file.ts'))).toBeNull()
    expect(sameGitResourceIdentity(repositoryRoot, malformedRoot)).toBe(false)
  })

  it('does not infer identity from an arbitrary .git path string', async () => {
    const repositoryRoot = await createRealGitRepository(
      tempDirs,
      'belay-git-identity-string-main-',
    )
    const outsideRoot = await mkdtemp(path.join(os.tmpdir(), 'belay-not-a-repository-'))
    tempDirs.push(outsideRoot)
    const arbitrary = path.join(outsideRoot, 'cache', '.git', 'objects', 'new-object')

    expect(resolveGitResourceIdentity(arbitrary)).toBeNull()
    expect(sameGitResourceIdentity(repositoryRoot, arbitrary)).toBe(false)
  })

  it('identifies proven Git metadata in normal and linked worktrees', async () => {
    const repositoryRoot = await createRealGitRepository(
      tempDirs,
      'belay-git-identity-metadata-main-',
    )
    const linkedRoot = `${repositoryRoot}-linked`
    await createRealLinkedWorktree(tempDirs, repositoryRoot, linkedRoot, 'metadata-linked')

    expect(isGitMetadataPath(path.join(repositoryRoot, '.git', 'config'), repositoryRoot)).toBe(
      true,
    )
    expect(isGitMetadataPath(path.join(linkedRoot, '.git'), repositoryRoot)).toBe(true)
    expect(isGitMetadataPath(path.join(linkedRoot, 'src', '.git', 'notes'), repositoryRoot)).toBe(
      false,
    )
  })

  it.runIf(process.platform !== 'win32')('canonicalizes repository symlinks', async () => {
    const repositoryRoot = await createRealGitRepository(
      tempDirs,
      'belay-git-identity-symlink-main-',
    )
    const aliasRoot = `${repositoryRoot}-alias`
    tempDirs.push(aliasRoot)
    await symlink(repositoryRoot, aliasRoot, 'dir')

    expect(resolveGitResourceIdentity(aliasRoot)?.repositoryRoot).toBe(
      canonicalPath(repositoryRoot),
    )
    expect(sameGitResourceIdentity(repositoryRoot, aliasRoot)).toBe(true)
  })

  it.runIf(process.platform !== 'win32')(
    'rejects an external worktree whose .git directory is a symlink',
    async () => {
      const repositoryRoot = await createRealGitRepository(
        tempDirs,
        'belay-git-identity-entry-dir-symlink-main-',
      )
      const spoofRoot = await mkdtemp(
        path.join(os.tmpdir(), 'belay-git-identity-entry-dir-symlink-spoof-'),
      )
      tempDirs.push(spoofRoot)
      await symlink(path.join(repositoryRoot, '.git'), path.join(spoofRoot, '.git'), 'dir')

      expect(inspectGitResourceIdentity(spoofRoot).status).toBe('invalid')
      expect(resolveGitResourceIdentity(spoofRoot)).toBeNull()
      expect(sameGitResourceIdentity(repositoryRoot, spoofRoot)).toBe(false)
    },
  )

  it.runIf(process.platform !== 'win32')(
    'rejects an external worktree whose .git file is a symlink',
    async () => {
      const repositoryRoot = await createRealGitRepository(
        tempDirs,
        'belay-git-identity-entry-file-symlink-main-',
      )
      const linkedRoot = `${repositoryRoot}-linked`
      await createRealLinkedWorktree(
        tempDirs,
        repositoryRoot,
        linkedRoot,
        'entry-file-symlink-linked',
      )
      const spoofRoot = await mkdtemp(
        path.join(os.tmpdir(), 'belay-git-identity-entry-file-symlink-spoof-'),
      )
      tempDirs.push(spoofRoot)
      await symlink(path.join(linkedRoot, '.git'), path.join(spoofRoot, '.git'), 'file')

      expect(inspectGitResourceIdentity(spoofRoot).status).toBe('invalid')
      expect(resolveGitResourceIdentity(spoofRoot)).toBeNull()
      expect(sameGitResourceIdentity(repositoryRoot, spoofRoot)).toBe(false)
    },
  )

  it('rejects an incomplete normal .git directory as malformed metadata', async () => {
    const repositoryRoot = await mkdtemp(path.join(os.tmpdir(), 'belay-git-identity-incomplete-'))
    tempDirs.push(repositoryRoot)
    await mkdir(path.join(repositoryRoot, '.git'))

    expect(resolveGitResourceIdentity(repositoryRoot)).toBeNull()
  })

  it('rejects a repository with an empty HEAD file', async () => {
    const repositoryRoot = await createRealGitRepository(tempDirs, 'belay-git-identity-empty-head-')
    await writeFile(path.join(repositoryRoot, '.git', 'HEAD'), '')

    expect(resolveGitResourceIdentity(repositoryRoot)).toBeNull()
  })

  it('rejects a repository with an empty config file', async () => {
    const repositoryRoot = await createRealGitRepository(
      tempDirs,
      'belay-git-identity-empty-config-',
    )
    await writeFile(path.join(repositoryRoot, '.git', 'config'), '')

    expect(resolveGitResourceIdentity(repositoryRoot)).toBeNull()
  })

  it('distinguishes absent Git boundaries from malformed metadata', async () => {
    const noGitRoot = await mkdtemp(path.join(os.tmpdir(), 'belay-git-identity-absent-'))
    const malformedRoot = await mkdtemp(path.join(os.tmpdir(), 'belay-git-identity-invalid-'))
    tempDirs.push(noGitRoot, malformedRoot)
    await writeFile(path.join(malformedRoot, '.git'), 'malformed\n')

    expect(inspectGitResourceIdentity(noGitRoot)).toEqual({ status: 'absent' })
    expect(inspectGitResourceIdentity(malformedRoot)).toMatchObject({
      status: 'invalid',
      boundaryPath: canonicalPath(malformedRoot),
    })
  })

  it.runIf(process.platform !== 'win32' && process.getuid?.() !== 0)(
    'fails closed when required Git metadata is unreadable',
    async () => {
      const repositoryRoot = await createRealGitRepository(
        tempDirs,
        'belay-git-identity-unreadable-',
      )
      const headPath = path.join(repositoryRoot, '.git', 'HEAD')
      await chmod(headPath, 0)
      try {
        expect(inspectGitResourceIdentity(repositoryRoot).status).toBe('invalid')
        expect(resolveGitResourceIdentity(repositoryRoot)).toBeNull()
      } finally {
        await chmod(headPath, 0o600)
      }
    },
  )

  it('rejects a gitdir outside canonical common-dir/worktrees', async () => {
    const repositoryRoot = await createRealGitRepository(tempDirs, 'belay-git-identity-spoof-main-')
    const spoofRoot = await mkdtemp(path.join(os.tmpdir(), 'belay-git-identity-spoof-worktree-'))
    const spoofGitDir = await mkdtemp(path.join(os.tmpdir(), 'belay-git-identity-spoof-gitdir-'))
    tempDirs.push(spoofRoot, spoofGitDir)
    await writeFile(path.join(spoofGitDir, 'HEAD'), 'ref: refs/heads/main\n')
    await writeFile(path.join(spoofGitDir, 'commondir'), `${path.join(repositoryRoot, '.git')}\n`)
    await writeFile(path.join(spoofGitDir, 'gitdir'), `${path.join(spoofRoot, '.git')}\n`)
    await writeFile(path.join(spoofRoot, '.git'), `gitdir: ${spoofGitDir}\n`)

    expect(resolveGitResourceIdentity(spoofRoot)).toBeNull()
    expect(sameGitResourceIdentity(repositoryRoot, spoofRoot)).toBe(false)
  })

  it('rejects a linked worktree whose gitdir backpointer was changed', async () => {
    const repositoryRoot = await createRealGitRepository(
      tempDirs,
      'belay-git-identity-backpointer-main-',
    )
    const linkedRoot = `${repositoryRoot}-linked`
    await createRealLinkedWorktree(tempDirs, repositoryRoot, linkedRoot, 'backpointer-linked')
    const gitDir = resolveGitResourceIdentity(linkedRoot)?.gitDir
    expect(gitDir).toBeDefined()
    await writeFile(path.join(gitDir ?? '', 'gitdir'), `${path.join(linkedRoot, '.git.other')}\n`)

    expect(resolveGitResourceIdentity(linkedRoot)).toBeNull()
  })

  it('resolves a bare repository root and nested metadata paths', async () => {
    const bareRoot = await createRealBareRepository(tempDirs, 'belay-git-identity-bare-')

    expect(resolveGitResourceIdentity(bareRoot)).toMatchObject({
      repositoryRoot: canonicalPath(bareRoot),
      gitDir: canonicalPath(bareRoot),
      commonDir: canonicalPath(bareRoot),
    })
    expect(
      resolveGitResourceIdentity(path.join(bareRoot, 'refs', 'heads', 'new-ref')),
    ).toMatchObject({
      repositoryRoot: canonicalPath(bareRoot),
      commonDir: canonicalPath(bareRoot),
    })
  })

  it('treats a nested bare repository as a separate identity', async () => {
    const repositoryRoot = await createRealGitRepository(
      tempDirs,
      'belay-git-identity-bare-parent-',
    )
    const bareRoot = path.join(repositoryRoot, 'vendor', 'remote.git')
    await mkdir(bareRoot, { recursive: true })
    await initializeRealBareRepository(bareRoot)

    expect(sameGitResourceIdentity(repositoryRoot, bareRoot)).toBe(false)
  })
})
