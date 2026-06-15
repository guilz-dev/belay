import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  resolveBelayConfigInteractiveMode,
  runBelayConfig,
  runBelayConfigInteractive,
  runBelayConfigJudgeOnlyInteractive,
} from '../../commands/config.js'
import { judgeUse } from '../../commands/judge.js'
import { loadConfigFile } from '../../config-io.js'
import { rejectDeprecatedJudgeModelAuto } from '../../core/judge-model-policy.js'
import * as installer from '../../installer.js'
import { initProject } from '../../installer.js'

const execFileAsync = promisify(execFile)
const tempDirs: string[] = []
const repoRoot = path.resolve(fileURLToPath(new URL('../../..', import.meta.url)))
const cliPath = path.join(repoRoot, 'dist/cli.js')

async function createTempRepo() {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'belay-plan-p35-'))
  tempDirs.push(tempDir)
  return tempDir
}

describe('Phase 3.5 plan — follow-ups', () => {
  afterEach(async () => {
    vi.restoreAllMocks()
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
  })

  describe('P35-1 model auto deprecation', () => {
    it('rejects belay config set judge.model auto', async () => {
      const dir = await createTempRepo()
      await initProject({ targetDir: dir, adapter: 'cursor' })
      await expect(
        runBelayConfig({
          targetDir: dir,
          subcommand: 'set',
          path: 'judge.model',
          value: 'auto',
        }),
      ).rejects.toThrow(/auto.*no longer accepted/i)
    })

    it('rejects judge model auto via policy helper', () => {
      expect(() => rejectDeprecatedJudgeModelAuto('auto')).toThrow(/no longer accepted/i)
      expect(() => rejectDeprecatedJudgeModelAuto('composer-2.5')).not.toThrow()
    })

    it('rejects belay init --judge-model auto', async () => {
      await expect(
        execFileAsync('node', [cliPath, 'init', '--judge-model', 'auto'], { cwd: repoRoot }),
      ).rejects.toThrow()
    })

    it('rejects judge use --model auto', async () => {
      const dir = await createTempRepo()
      await initProject({ targetDir: dir, adapter: 'cursor' })
      await expect(
        judgeUse({ targetDir: dir, providerId: 'cursor', model: 'auto' }),
      ).rejects.toThrow(/no longer accepted/i)
    })
  })

  describe('P35-2 judge-only interactive config', () => {
    it('resolveBelayConfigInteractiveMode returns judge-only after init', async () => {
      const dir = await createTempRepo()
      await initProject({ targetDir: dir, adapter: 'cursor', withSkill: false })
      await expect(resolveBelayConfigInteractiveMode(dir)).resolves.toBe('judge-only')
    })

    it('resolveBelayConfigInteractiveMode returns full before install', async () => {
      const dir = await createTempRepo()
      await expect(resolveBelayConfigInteractiveMode(dir)).resolves.toBe('full')
    })

    it('judge-only interactive updates provider without initProject', async () => {
      const dir = await createTempRepo()
      await initProject({ targetDir: dir, adapter: 'cursor', withSkill: false })
      const hooksPath = path.join(dir, '.cursor', 'hooks.json')
      const hooksBefore = await readFile(hooksPath, 'utf8')
      const initSpy = vi.spyOn(installer, 'initProject')

      await runBelayConfigJudgeOnlyInteractive({
        targetDir: dir,
        prompts: ['codex', 'y', '', ''],
      })

      expect(initSpy).not.toHaveBeenCalled()
      const config = await loadConfigFile(dir)
      expect(config.judge.providerId).toBe('codex')
      const hooksAfter = await readFile(hooksPath, 'utf8')
      expect(hooksAfter).toBe(hooksBefore)
    })

    it('judge-only records cloud consent when endpoint and acceptance provided', async () => {
      const dir = await createTempRepo()
      await initProject({ targetDir: dir, adapter: 'cursor', withSkill: false })

      await runBelayConfigJudgeOnlyInteractive({
        targetDir: dir,
        prompts: ['codex', 'y', 'https://api.openai.com/v1', 'y'],
      })

      const config = await loadConfigFile(dir)
      expect(config.judge.cloudConsent?.accepted).toBe(true)
      expect(config.judge.endpoint).toBe('https://api.openai.com/v1')
    })

    it('runBelayConfigInteractive full path when user declines judge-only', async () => {
      const dir = await createTempRepo()
      await initProject({ targetDir: dir, adapter: 'cursor', withSkill: false })
      const initSpy = vi.spyOn(installer, 'initProject')

      await runBelayConfigInteractive({
        targetDir: dir,
        prompts: ['n', 'cursor', 'project', 'n', 'ollama'],
      })

      expect(initSpy).toHaveBeenCalled()
    })
  })
})
