import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import type { ScopedPaths } from '../adapters/layouts/scope.js'
import { writeRuntimeArtifacts } from '../installer/runtime-artifacts.js'

vi.mock('../templates.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../templates.js')>()
  return {
    ...actual,
    renderCursorDispatcher: async () => {
      throw new Error('dispatcher render failed')
    },
  }
})

const tempDirs: string[] = []

describe('runtime artifact installation', () => {
  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
  })

  it('preserves live artifacts when dispatcher rendering fails', async () => {
    const repoRoot = await mkdtemp(path.join(os.tmpdir(), 'belay-runtime-artifacts-'))
    tempDirs.push(repoRoot)
    const hooksDir = path.join(repoRoot, '.cursor', 'hooks')
    const runtimeDir = path.join(repoRoot, '.cursor', 'belay', 'runtime')
    const paths: ScopedPaths = {
      scope: 'project',
      repoRoot,
      configPath: path.join(repoRoot, '.cursor', 'belay.config.json'),
      hooksSettingsPath: path.join(repoRoot, '.cursor', 'hooks.json'),
      hooksDir,
      runtimeDir,
      repoLocalStateDir: path.join(repoRoot, '.cursor', 'belay'),
      skillsDir: path.join(repoRoot, '.cursor', 'skills', 'belay'),
    }
    const existingArtifacts = new Map([
      [path.join(hooksDir, 'belay-before-submit.mjs'), 'old before-submit\n'],
      [path.join(hooksDir, 'belay-shell-gate.mjs'), 'old shell-gate\n'],
      [path.join(hooksDir, 'belay-tool-gate.mjs'), 'old tool-gate\n'],
      [path.join(hooksDir, 'belay-audit.mjs'), 'old audit\n'],
      [path.join(hooksDir, 'belay-runner'), 'old runner\n'],
      [path.join(hooksDir, 'belay-runner.cmd'), 'old runner cmd\n'],
      [path.join(hooksDir, 'belay-runner.ps1'), 'old runner powershell\n'],
      [path.join(runtimeDir, 'core.mjs'), 'old core\n'],
      [path.join(runtimeDir, 'dispatcher.mjs'), 'old dispatcher\n'],
    ])
    await mkdir(hooksDir, { recursive: true })
    await mkdir(runtimeDir, { recursive: true })
    await Promise.all(
      [...existingArtifacts].map(([filePath, content]) => writeFile(filePath, content)),
    )

    await expect(writeRuntimeArtifacts('cursor', paths)).rejects.toThrow('dispatcher render failed')

    for (const [filePath, content] of existingArtifacts) {
      await expect(readFile(filePath, 'utf8')).resolves.toBe(content)
    }
  })
})
