import { realpathSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import {
  hasDuplicateCursorShellGates,
  legacyManagedShellPreToolUseEntry,
  mergeCursorHooksFile,
  stripCursorHooksFile,
} from '../adapters/cursor/hooks.js'
import { getManagedHookEntries } from '../defaults.js'
import { initProject, upgradeCursorProject } from '../installer.js'

const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

async function createTempRepo() {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'belay-cursor-hooks-'))
  tempDirs.push(tempDir)
  return tempDir
}

async function readJson(filePath: string) {
  return JSON.parse(await readFile(filePath, 'utf8'))
}

describe('cursor hook dedupe', () => {
  it('migrates exact legacy-relative entries to one absolute entry without reordering custom hooks', () => {
    const canonicalTempDir = realpathSync(os.tmpdir())
    const repoRoot = path.join(canonicalTempDir, 'project with spaces')
    const hooksDir = path.join(repoRoot, '.cursor', 'hooks')
    const legacyAbsoluteRunner = path.join(
      hooksDir,
      process.platform === 'win32' ? 'belay-runner.cmd' : 'belay-runner',
    )
    const legacyAbsoluteShell = { command: `${legacyAbsoluteRunner} belay-shell-gate` }
    const canonicalRunner = path.join(
      canonicalTempDir,
      'project with spaces',
      '.cursor',
      'hooks',
      process.platform === 'win32' ? 'belay-runner.cmd' : 'belay-runner',
    )
    const quotedCanonicalRunner =
      process.platform === 'win32'
        ? `"${canonicalRunner}"`
        : `'${canonicalRunner.replaceAll("'", "'\\''")}'`
    const currentShellCommand = `${quotedCanonicalRunner} belay-shell-gate`
    const legacyRunner =
      process.platform === 'win32'
        ? '.\\.cursor\\hooks\\belay-runner.cmd'
        : './.cursor/hooks/belay-runner'
    const legacyShell = { command: `${legacyRunner} belay-shell-gate` }
    const customBefore = { command: 'custom-before', metadata: { keep: 'byte-for-byte' } }
    const customMiddle = { command: 'custom-middle', matcher: 'Shell' }
    const customAfter = { command: 'custom-after' }
    const unknownBelayLike = { command: `${legacyRunner} belay-shell-gate --custom` }
    const hooks = {
      version: 1,
      hooks: {
        beforeShellExecution: [
          customBefore,
          legacyShell,
          customMiddle,
          legacyAbsoluteShell,
          legacyShell,
          unknownBelayLike,
          customAfter,
        ],
      },
    }

    const merged = mergeCursorHooksFile(hooks, process.platform, hooksDir, repoRoot)

    expect(merged.hooks.beforeShellExecution).toEqual([
      { command: currentShellCommand, matcher: undefined },
      customBefore,
      customMiddle,
      unknownBelayLike,
      customAfter,
    ])
  })

  it('strips exact relative and absolute managed entries but preserves unknown commands in order', () => {
    const repoRoot = path.join(realpathSync(os.tmpdir()), 'project')
    const hooksDir = path.join(repoRoot, '.cursor', 'hooks')
    const absoluteShell = {
      command: `${path.join(
        hooksDir,
        process.platform === 'win32' ? 'belay-runner.cmd' : 'belay-runner',
      )} belay-shell-gate`,
    }
    const legacyRunner =
      process.platform === 'win32'
        ? '.\\.cursor\\hooks\\belay-runner.cmd'
        : './.cursor/hooks/belay-runner'
    const customBefore = { command: 'custom-before' }
    const unknownBelayLike = { command: `${legacyRunner} belay-shell-gate --unknown` }
    const customAfter = { command: 'custom-after' }

    const stripped = stripCursorHooksFile(
      {
        version: 1,
        hooks: {
          beforeShellExecution: [
            customBefore,
            { command: `${legacyRunner} belay-shell-gate` },
            unknownBelayLike,
            absoluteShell,
            customAfter,
          ],
        },
      },
      process.platform,
      hooksDir,
      repoRoot,
    )

    expect(stripped.hooks.beforeShellExecution).toEqual([
      customBefore,
      unknownBelayLike,
      customAfter,
    ])
  })

  it('migrates the prior quoted Windows cmd command to one encoded PowerShell command', () => {
    const repoRoot = path.join(realpathSync(os.tmpdir()), 'windows %TEMP% !NAME! project')
    const hooksDir = path.join(repoRoot, '.cursor', 'hooks')
    const prior = getManagedHookEntries('win32', hooksDir, repoRoot, 'legacy-quoted-absolute').find(
      (entry) => entry.event === 'beforeShellExecution',
    )?.definition
    const current = getManagedHookEntries('win32', hooksDir, repoRoot).find(
      (entry) => entry.event === 'beforeShellExecution',
    )?.definition
    expect(prior).toBeDefined()
    expect(current).toBeDefined()
    if (!prior || !current) {
      throw new Error('Windows managed hook definitions are missing')
    }

    const customBefore = { command: 'custom-before' }
    const unknownLookalike = { command: `${prior.command} --unknown` }
    const merged = mergeCursorHooksFile(
      {
        version: 1,
        hooks: {
          beforeShellExecution: [customBefore, prior, unknownLookalike, prior],
        },
      },
      'win32',
      hooksDir,
      repoRoot,
    )

    expect(merged.hooks.beforeShellExecution).toEqual([
      { command: current.command, matcher: current.matcher },
      customBefore,
      unknownLookalike,
    ])

    const stripped = stripCursorHooksFile(
      {
        version: 1,
        hooks: { beforeShellExecution: [customBefore, prior, unknownLookalike, prior] },
      },
      'win32',
      hooksDir,
      repoRoot,
    )
    expect(stripped.hooks.beforeShellExecution).toEqual([customBefore, unknownLookalike])
  })

  it('detects duplicate Shell preToolUse gate entries', () => {
    const repoRoot = '/tmp/project'
    const hooksDir = `${repoRoot}/.cursor/hooks`
    const shellEntry = legacyManagedShellPreToolUseEntry(process.platform, hooksDir, repoRoot)
    const hooks = {
      version: 1,
      hooks: {
        preToolUse: [shellEntry, shellEntry],
      },
    }

    expect(hasDuplicateCursorShellGates(hooks, process.platform, hooksDir, repoRoot)).toBe(true)
    expect(
      mergeCursorHooksFile(hooks, process.platform, hooksDir, repoRoot).hooks.preToolUse?.filter(
        (entry) => entry.matcher === 'Shell',
      ),
    ).toHaveLength(1)
  })

  it('dedupes duplicate Shell preToolUse gates on upgrade', async () => {
    const repoRoot = await createTempRepo()
    await initProject({ targetDir: repoRoot })

    const hooksPath = path.join(repoRoot, '.cursor', 'hooks.json')
    const hooksDir = path.join(repoRoot, '.cursor', 'hooks')
    const hooks = await readJson(hooksPath)
    const shellEntry = legacyManagedShellPreToolUseEntry(process.platform, hooksDir, repoRoot)
    hooks.hooks.preToolUse = [shellEntry, shellEntry, ...(hooks.hooks.preToolUse ?? [])]
    await writeFile(hooksPath, `${JSON.stringify(hooks, null, 2)}\n`, 'utf8')

    expect(hasDuplicateCursorShellGates(hooks, process.platform, hooksDir, repoRoot)).toBe(true)

    await upgradeCursorProject({ targetDir: repoRoot })
    const upgraded = await readJson(hooksPath)

    expect(hasDuplicateCursorShellGates(upgraded, process.platform, hooksDir, repoRoot)).toBe(false)
    expect(
      upgraded.hooks.preToolUse.filter((entry: { matcher?: string }) => entry.matcher === 'Shell'),
    ).toHaveLength(1)
    expect(upgraded.hooks.beforeShellExecution).toHaveLength(1)
  })
})
