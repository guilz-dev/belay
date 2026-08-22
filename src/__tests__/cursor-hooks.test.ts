import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import {
  hasDuplicateCursorShellGates,
  legacyManagedShellPreToolUseEntry,
  mergeCursorHooksFile,
} from '../adapters/cursor/hooks.js'
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
  it('detects legacy Shell preToolUse gate duplication', () => {
    const repoRoot = '/tmp/project'
    const hooksDir = `${repoRoot}/.cursor/hooks`
    const legacy = legacyManagedShellPreToolUseEntry(process.platform, hooksDir, repoRoot)
    const hooks = {
      version: 1,
      hooks: {
        preToolUse: [legacy],
      },
    }

    expect(hasDuplicateCursorShellGates(hooks, process.platform, hooksDir, repoRoot)).toBe(true)
    expect(
      mergeCursorHooksFile(hooks, process.platform, hooksDir, repoRoot).hooks.preToolUse,
    ).not.toEqual(expect.arrayContaining([expect.objectContaining({ matcher: 'Shell' })]))
  })

  it('removes legacy Shell preToolUse gate on upgrade', async () => {
    const repoRoot = await createTempRepo()
    await initProject({ targetDir: repoRoot })

    const hooksPath = path.join(repoRoot, '.cursor', 'hooks.json')
    const hooksDir = path.join(repoRoot, '.cursor', 'hooks')
    const hooks = await readJson(hooksPath)
    const legacy = legacyManagedShellPreToolUseEntry(process.platform, hooksDir, repoRoot)
    hooks.hooks.preToolUse = [legacy, ...(hooks.hooks.preToolUse ?? [])]
    await writeFile(hooksPath, `${JSON.stringify(hooks, null, 2)}\n`, 'utf8')

    expect(hasDuplicateCursorShellGates(hooks, process.platform, hooksDir, repoRoot)).toBe(true)

    await upgradeCursorProject({ targetDir: repoRoot })
    const upgraded = await readJson(hooksPath)

    expect(hasDuplicateCursorShellGates(upgraded, process.platform, hooksDir, repoRoot)).toBe(false)
    expect(
      upgraded.hooks.preToolUse.some((entry: { matcher?: string }) => entry.matcher === 'Shell'),
    ).toBe(false)
    expect(upgraded.hooks.beforeShellExecution).toHaveLength(1)
  })
})
