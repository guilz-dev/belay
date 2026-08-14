import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { canonicalPath } from '../../core/path-utils.js'
import { analyzePathTargets, resolveTrustedPath } from '../../core/verdict/containment.js'
import {
  createRealGitRepository,
  createRealLinkedWorktree,
  initializeRealGitRepository,
} from '../helpers/git-fixtures.js'
import { verdictTestContext } from './helpers.js'

const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

describe('containment', () => {
  const ctx = verdictTestContext()

  it('resolves repo-local paths with trusted cwd', () => {
    const resolved = resolveTrustedPath('package.json', ctx.cwd, true)
    expect(resolved).toBe(path.resolve(ctx.cwd, 'package.json'))
  })

  it('marks .git destruction as high stakes', () => {
    const analysis = analyzePathTargets({
      targets: ['.git'],
      cwd: ctx.cwd,
      repoRoot: ctx.repoRoot,
      trustedCwd: true,
      sensitivePaths: ctx.sensitivePaths,
    })
    expect(analysis.isHighStakes).toBe(true)
    expect(analysis.location).toBe('repo_local')
  })

  it('marks nested .git paths as high stakes from subdirectory cwd', () => {
    const repoRoot = '/workspace/project'
    const cwd = path.join(repoRoot, 'src')
    const analysis = analyzePathTargets({
      targets: ['.git'],
      cwd,
      repoRoot,
      trustedCwd: true,
      sensitivePaths: ['.env', '.env.*', '**/credentials/**'],
    })
    expect(analysis.isHighStakes).toBe(true)
    expect(analysis.signals).toContain('high_stakes_path')
  })

  it('marks repo-outside secret targets as high stakes', () => {
    const analysis = analyzePathTargets({
      targets: ['~/.env'],
      cwd: ctx.cwd,
      repoRoot: ctx.repoRoot,
      trustedCwd: true,
      sensitivePaths: ctx.sensitivePaths,
    })
    expect(analysis.isHighStakes).toBe(true)
    expect(analysis.location).toBe('repo_outside')
    expect(analysis.signals).toContain('high_stakes_path')
  })

  it('treats trusted workspace roots as repo-local location', () => {
    const trustedRoot = canonicalPath(path.join(process.env.HOME ?? '/home/user', '.cursor/plans'))
    const analysis = analyzePathTargets({
      targets: [path.join(trustedRoot, 'foo.plan.md')],
      cwd: ctx.cwd,
      repoRoot: ctx.repoRoot,
      trustedCwd: true,
      trustedWorkspaceRoots: [trustedRoot],
      sensitivePaths: ctx.sensitivePaths,
    })
    expect(analysis.location).toBe('repo_local')
    expect(analysis.isHighStakes).toBe(false)
  })

  it('marks sensitive paths in trusted roots as high stakes', () => {
    const trustedRoot = canonicalPath(path.join(process.env.HOME ?? '/home/user', '.cursor/plans'))
    const analysis = analyzePathTargets({
      targets: [path.join(trustedRoot, '.env')],
      cwd: ctx.cwd,
      repoRoot: ctx.repoRoot,
      trustedCwd: true,
      trustedWorkspaceRoots: [trustedRoot],
      sensitivePaths: ctx.sensitivePaths,
    })
    expect(analysis.location).toBe('repo_local')
    expect(analysis.isHighStakes).toBe(true)
  })

  it('marks credential paths in trusted roots as high stakes', () => {
    const trustedRoot = canonicalPath(path.join(process.env.HOME ?? '/home/user', '.cursor/plans'))
    const analysis = analyzePathTargets({
      targets: [path.join(trustedRoot, '.npmrc')],
      cwd: ctx.cwd,
      repoRoot: ctx.repoRoot,
      trustedCwd: true,
      trustedWorkspaceRoots: [trustedRoot],
      sensitivePaths: ctx.sensitivePaths,
    })
    expect(analysis.location).toBe('repo_local')
    expect(analysis.isHighStakes).toBe(true)
    expect(analysis.signals).toContain('high_stakes_path')
  })

  it('returns unknown location without trusted cwd', () => {
    const analysis = analyzePathTargets({
      targets: ['foo.txt'],
      cwd: '',
      repoRoot: ctx.repoRoot,
      trustedCwd: false,
      sensitivePaths: ctx.sensitivePaths,
    })
    expect(analysis.location).toBe('unknown')
    expect(analysis.signals).toContain('missing_trusted_cwd')
  })

  it('locates linked-worktree targets as repo-local by common-dir identity', async () => {
    const repositoryRoot = await createRealGitRepository(tempDirs, 'belay-containment-linked-main-')
    const linkedRoot = `${repositoryRoot}-linked`
    await createRealLinkedWorktree(tempDirs, repositoryRoot, linkedRoot, 'linked')

    const analysis = analyzePathTargets({
      targets: [path.join(linkedRoot, 'nested', 'new-file.ts')],
      cwd: repositoryRoot,
      repoRoot: repositoryRoot,
      trustedCwd: true,
      sensitivePaths: [],
    })

    expect(analysis.location).toBe('repo_local')
    expect(analysis.isHighStakes).toBe(false)
  })

  it('keeps linked-worktree Git metadata high stakes', async () => {
    const repositoryRoot = await createRealGitRepository(
      tempDirs,
      'belay-containment-metadata-main-',
    )
    const linkedRoot = `${repositoryRoot}-linked`
    await createRealLinkedWorktree(tempDirs, repositoryRoot, linkedRoot, 'metadata-linked')

    const analysis = analyzePathTargets({
      targets: [path.join(linkedRoot, '.git')],
      cwd: repositoryRoot,
      repoRoot: repositoryRoot,
      trustedCwd: true,
      sensitivePaths: [],
    })

    expect(analysis.location).toBe('repo_local')
    expect(analysis.isHighStakes).toBe(true)
  })

  it('marks malformed root Git-control-like paths high stakes and non-local', async () => {
    const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), 'belay-containment-malformed-root-'))
    tempDirs.push(workspaceRoot)
    await writeFile(path.join(workspaceRoot, '.git'), 'malformed\n')

    const analysis = analyzePathTargets({
      targets: [path.join(workspaceRoot, '.git', 'config')],
      cwd: workspaceRoot,
      repoRoot: workspaceRoot,
      trustedCwd: true,
      sensitivePaths: [],
    })

    expect(analysis.location).toBe('repo_outside')
    expect(analysis.isHighStakes).toBe(true)
  })

  it('protects Git metadata in a separate nested repository', async () => {
    const repositoryRoot = await createRealGitRepository(
      tempDirs,
      'belay-containment-separate-main-',
    )
    const separateRoot = path.join(repositoryRoot, 'vendor', 'separate')
    await mkdir(separateRoot, { recursive: true })
    await initializeRealGitRepository(separateRoot)

    const analysis = analyzePathTargets({
      targets: [path.join(separateRoot, '.git', 'config')],
      cwd: repositoryRoot,
      repoRoot: repositoryRoot,
      trustedCwd: true,
      sensitivePaths: [],
    })

    expect(analysis.location).toBe('repo_outside')
    expect(analysis.isHighStakes).toBe(true)
  })
})
