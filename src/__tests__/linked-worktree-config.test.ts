import { execFile } from 'node:child_process'
import { realpathSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'

import { afterEach, describe, expect, it } from 'vitest'
import { getAdapterLayout } from '../adapters/layouts/index.js'
import { doctorProject } from '../commands/doctor.js'
import { dogfoodProject } from '../commands/dogfood.js'
import { loadLayeredConfig } from '../config-io.js'
import { detectUndogfoodedLinkedWorktrees } from '../core/dogfood-environment.js'
import {
  findInheritedRepoConfig,
  isPrimaryGitWorktree,
  resolveRepoConfig,
} from '../core/linked-worktree-config.js'
import { initProject } from '../installer.js'

const execFileAsync = promisify(execFile)
const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

async function initGitRepo(repoRoot: string): Promise<void> {
  await writeFile(path.join(repoRoot, 'README.md'), '# root\n')
  await execFileAsync('git', ['init', '--quiet'], { cwd: repoRoot })
  await execFileAsync('git', ['add', 'README.md'], { cwd: repoRoot })
  await execFileAsync(
    'git',
    [
      '-c',
      'user.name=belay-test',
      '-c',
      'user.email=belay-test@example.com',
      'commit',
      '-m',
      'init',
    ],
    { cwd: repoRoot },
  )
}

async function addLinkedWorktree(repoRoot: string, linkedWorktree: string): Promise<void> {
  await execFileAsync(
    'git',
    ['worktree', 'add', linkedWorktree, '-b', path.basename(linkedWorktree)],
    {
      cwd: repoRoot,
    },
  )
}

describe('linked-worktree-config', () => {
  it('detects the primary checkout by .git directory shape', async () => {
    const repoRoot = await mkdtemp(path.join(os.tmpdir(), 'belay-primary-wt-'))
    const linkedParent = await mkdtemp(path.join(os.tmpdir(), 'belay-linked-parent-'))
    const linkedWorktree = path.join(linkedParent, 'linked-worktree')
    tempDirs.push(repoRoot, linkedParent)
    await initGitRepo(repoRoot)
    await addLinkedWorktree(repoRoot, linkedWorktree)

    expect(isPrimaryGitWorktree(repoRoot)).toBe(true)
    expect(isPrimaryGitWorktree(linkedWorktree)).toBe(false)
  })

  it('inherits repo config from the primary worktree when the linked checkout has no belay.config.json', async () => {
    const repoRoot = await mkdtemp(path.join(os.tmpdir(), 'belay-inherit-primary-'))
    const linkedParent = await mkdtemp(path.join(os.tmpdir(), 'belay-inherit-linked-'))
    const linkedWorktree = path.join(linkedParent, 'linked-worktree')
    tempDirs.push(repoRoot, linkedParent)
    await initProject({ targetDir: repoRoot, dogfood: true })
    await initGitRepo(repoRoot)
    await addLinkedWorktree(repoRoot, linkedWorktree)

    const inherited = await findInheritedRepoConfig(linkedWorktree, 'cursor')
    expect(inherited).not.toBeNull()
    expect(realpathSync(inherited?.sourceRoot ?? '')).toBe(realpathSync(repoRoot))

    const layered = await loadLayeredConfig(linkedWorktree, 'cursor')
    expect(layered.config.mode).toBe('audit')
    expect(layered.config.policy.unknownLocalEffect).toBe('deny')
    expect(layered.provenance.some((entry) => entry.source === 'inherited')).toBe(true)
  })

  it('prefers a local belay.config.json over inherited sibling config', async () => {
    const repoRoot = await mkdtemp(path.join(os.tmpdir(), 'belay-local-over-inherit-'))
    const linkedParent = await mkdtemp(path.join(os.tmpdir(), 'belay-local-linked-'))
    const linkedWorktree = path.join(linkedParent, 'linked-worktree')
    tempDirs.push(repoRoot, linkedParent)
    await initProject({ targetDir: repoRoot, dogfood: true })
    await initGitRepo(repoRoot)
    await addLinkedWorktree(repoRoot, linkedWorktree)

    const localConfigPath = path.join(linkedWorktree, '.cursor', 'belay.config.json')
    const primaryConfig = JSON.parse(
      await readFile(path.join(repoRoot, '.cursor', 'belay.config.json'), 'utf8'),
    )
    await mkdir(path.join(linkedWorktree, '.cursor'), { recursive: true })
    await writeFile(
      localConfigPath,
      `${JSON.stringify({
        ...primaryConfig,
        mode: 'enforce',
      })}\n`,
    )

    const resolution = await resolveRepoConfig(linkedWorktree, 'cursor')
    expect(resolution.inherited).toBe(false)
    expect(resolution.configSourceRoot).toBe(linkedWorktree)
    expect(resolution.repoConfig).toMatchObject({ mode: 'enforce' })
  })

  it('fails closed when the local belay.config.json exists but is unreadable', async () => {
    const repoRoot = await mkdtemp(path.join(os.tmpdir(), 'belay-unreadable-local-config-'))
    const linkedParent = await mkdtemp(path.join(os.tmpdir(), 'belay-unreadable-linked-'))
    const linkedWorktree = path.join(linkedParent, 'linked-worktree')
    tempDirs.push(repoRoot, linkedParent)
    await initProject({ targetDir: repoRoot, dogfood: true })
    await initGitRepo(repoRoot)
    await addLinkedWorktree(repoRoot, linkedWorktree)
    await mkdir(path.join(linkedWorktree, '.cursor'), { recursive: true })
    await writeFile(path.join(linkedWorktree, '.cursor', 'belay.config.json'), '{not-json')

    await expect(resolveRepoConfig(linkedWorktree, 'cursor')).rejects.toMatchObject({
      name: 'RepoConfigReadError',
    })
  })

  it('does not flag linked worktrees as undogfooded when they inherit primary dogfood config', async () => {
    const repoRoot = await mkdtemp(path.join(os.tmpdir(), 'belay-inherit-dogfood-env-'))
    const linkedParent = await mkdtemp(path.join(os.tmpdir(), 'belay-inherit-dogfood-linked-'))
    const linkedWorktree = path.join(linkedParent, 'linked-worktree')
    tempDirs.push(repoRoot, linkedParent)
    await initProject({ targetDir: repoRoot })
    await dogfoodProject({ targetDir: repoRoot })
    await initGitRepo(repoRoot)
    await addLinkedWorktree(repoRoot, linkedWorktree)

    const warnings = await detectUndogfoodedLinkedWorktrees({
      repoRoot,
      adapterName: 'cursor',
      layout: getAdapterLayout('cursor'),
    })

    expect(warnings).toEqual([])
  })

  it('reports inherited config in doctor without a missing-config issue', async () => {
    const repoRoot = await mkdtemp(path.join(os.tmpdir(), 'belay-doctor-inherited-config-'))
    const linkedParent = await mkdtemp(path.join(os.tmpdir(), 'belay-doctor-inherited-linked-'))
    const linkedWorktree = path.join(linkedParent, 'linked-worktree')
    tempDirs.push(repoRoot, linkedParent)
    await initProject({ targetDir: repoRoot, dogfood: true })
    await initGitRepo(repoRoot)
    await addLinkedWorktree(repoRoot, linkedWorktree)

    const report = await doctorProject({ targetDir: linkedWorktree })

    expect(report.issues.some((issue) => issue.startsWith('Missing config:'))).toBe(false)
    expect(
      report.notes.some((note) =>
        note.includes('Repository config inherited from linked worktree'),
      ),
    ).toBe(true)
  })
})
