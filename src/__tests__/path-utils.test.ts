import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import {
  canonicalPath,
  containingGitRoot,
  hasOutsideRepoPath,
  pathWithinRoot,
  relativeWithinRepo,
  resolveWorkspaceRootMatch,
} from '../core/path-utils.js'

const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

describe('relativeWithinRepo', () => {
  it('resolves symlinked paths inside the repository (R5)', async () => {
    const repoRoot = await mkdtemp(path.join(os.tmpdir(), 'belay-repo-'))
    tempDirs.push(repoRoot)
    const realDir = path.join(repoRoot, 'real')
    const linkPath = path.join(repoRoot, 'link.txt')
    await mkdir(realDir, { recursive: true })
    await writeFile(path.join(realDir, 'secret.txt'), 'x')
    await symlink(path.join(realDir, 'secret.txt'), linkPath)

    expect(relativeWithinRepo(repoRoot, linkPath)).toBe(path.join('real', 'secret.txt'))
  })

  it('treats symlink escape targets as outside the repo', async () => {
    const outsideDir = await mkdtemp(path.join(os.tmpdir(), 'belay-out-'))
    tempDirs.push(outsideDir)
    const repoRoot = await mkdtemp(path.join(os.tmpdir(), 'belay-repo2-'))
    tempDirs.push(repoRoot)
    const outsideFile = path.join(outsideDir, 'outside.txt')
    const linkPath = path.join(repoRoot, 'escape.txt')
    await writeFile(outsideFile, 'x')
    await symlink(outsideFile, linkPath)

    expect(relativeWithinRepo(repoRoot, linkPath)).toBeNull()
  })
})

describe('canonicalPath', () => {
  it('keeps non-existent suffixes under a symlink-resolved repo root', async () => {
    const base = await mkdtemp(path.join(os.tmpdir(), 'belay-canonical-'))
    tempDirs.push(base)
    const privateRoot = path.join(base, 'private')
    const varLink = path.join(base, 'var')
    await mkdir(privateRoot, { recursive: true })
    await symlink(privateRoot, varLink)
    const repoRoot = path.join(varLink, 'project')
    await mkdir(repoRoot, { recursive: true })

    const newFile = path.join(repoRoot, 'notes.txt')
    expect(pathWithinRoot(repoRoot, newFile)).toBe(true)
    expect(canonicalPath(newFile).startsWith(canonicalPath(repoRoot))).toBe(true)
  })

  it('matches allowlist targets collected from shell redirects', async () => {
    const base = await mkdtemp(path.join(os.tmpdir(), 'belay-canonical-out-'))
    tempDirs.push(base)
    const privateRoot = path.join(base, 'private')
    const varLink = path.join(base, 'var')
    const outsidePath = path.join(varLink, 'outside.txt')
    await mkdir(privateRoot, { recursive: true })
    await symlink(privateRoot, varLink)
    const repoRoot = path.join(varLink, 'project')
    await mkdir(repoRoot, { recursive: true })

    expect(canonicalPath(outsidePath)).toBe(
      canonicalPath(path.resolve(repoRoot, '..', 'outside.txt')),
    )
  })
})

describe('hasOutsideRepoPath', () => {
  it('ignores bare subcommand tokens such as git status', async () => {
    const repoRoot = await mkdtemp(path.join(os.tmpdir(), 'belay-git-status-'))
    tempDirs.push(repoRoot)
    expect(hasOutsideRepoPath(['status'], repoRoot, repoRoot)).toBe(false)
    expect(hasOutsideRepoPath(['origin', 'main'], repoRoot, repoRoot)).toBe(false)
  })
})

describe('resolveWorkspaceRootMatch', () => {
  it('matches trusted workspace roots outside repo', () => {
    const repoRoot = '/workspace/repo'
    const trusted = ['/Users/user/.cursor/plans']
    const target = '/Users/user/.cursor/plans/foo.plan.md'
    const match = resolveWorkspaceRootMatch(repoRoot, trusted, target)
    expect(match).toEqual({
      kind: 'trusted',
      root: canonicalPath('/Users/user/.cursor/plans'),
      relativePath: 'foo.plan.md',
    })
  })

  it('fails closed when trusted root path later becomes a symlink', async () => {
    const repoRoot = await mkdtemp(path.join(os.tmpdir(), 'belay-repo-root-'))
    const trustedRoot = await mkdtemp(path.join(os.tmpdir(), 'belay-trusted-root-'))
    const outsideDir = await mkdtemp(path.join(os.tmpdir(), 'belay-outside-root-'))
    tempDirs.push(repoRoot, trustedRoot, outsideDir)
    const frozenTrustedRoot = canonicalPath(trustedRoot)
    const initialTarget = path.join(trustedRoot, 'note.md')
    await writeFile(initialTarget, 'x')
    expect(resolveWorkspaceRootMatch(repoRoot, [frozenTrustedRoot], initialTarget)?.kind).toBe(
      'trusted',
    )

    await rm(trustedRoot, { recursive: true, force: true })
    await symlink(outsideDir, trustedRoot)
    const escapedTarget = path.join(trustedRoot, 'escape.txt')
    expect(resolveWorkspaceRootMatch(repoRoot, [frozenTrustedRoot], escapedTarget)).toBeNull()
  })
})

describe('containingGitRoot', () => {
  it('returns null for non-git-managed directories', async () => {
    const nonGitDir = await mkdtemp(path.join(os.tmpdir(), 'belay-nongit-'))
    tempDirs.push(nonGitDir)
    expect(containingGitRoot(nonGitDir)).toBeNull()
  })
})
