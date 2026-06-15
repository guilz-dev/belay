import { execFile, spawn } from 'node:child_process'
import { access, mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

import { afterEach, describe, expect, it } from 'vitest'

import { judgeStatus } from '../../commands/judge.js'
import { doctorProject } from '../../commands/doctor.js'
import { formatStatusReport, statusProject } from '../../commands/status.js'
import { loadConfigFile, repoLocalStateDirFor } from '../../config-io.js'
import { belayStateDir } from '../../core/config.js'
import { readJudgeCredentialStore } from '../../core/credential-store.js'
import { initProject } from '../../installer.js'
import { verdict } from '../../core/verdict/verdict.js'
import { verdictTestContext } from '../verdict/helpers.js'
import { PLAN_BELAY_CONFIG_SUBCOMMANDS } from './plan-fixtures.js'

const execFileAsync = promisify(execFile)
const tempDirs: string[] = []
const repoRoot = path.resolve(fileURLToPath(new URL('../../..', import.meta.url)))
const cliPath = path.join(repoRoot, 'dist/cli.js')
const BUNDLED_SKILL_PATH = path.join(repoRoot, 'skills/belay/SKILL.md')

async function createTempRepo() {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'belay-plan-p2-'))
  tempDirs.push(tempDir)
  return tempDir
}

async function importConfigModule() {
  return import('../../commands/config.js')
}

describe('Phase 2 plan — Config UX', () => {
  const context = verdictTestContext()

  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
  })

  describe('P2-1 skills path: skill only, hooks not installed', () => {
    it('bundled skill mentions belay config as setup path', async () => {
      await expect(access(BUNDLED_SKILL_PATH)).resolves.toBeUndefined()
      const skill = await readFile(BUNDLED_SKILL_PATH, 'utf8')
      expect(skill).toMatch(/belay config/i)
      expect(skill).not.toMatch(/init-wizard/i)
    })

    it('skill states runtime gate is not installed after skills add alone', async () => {
      const skill = await readFile(BUNDLED_SKILL_PATH, 'utf8')
      expect(skill).toMatch(/not installed|requires|belay config/i)
      expect(skill).not.toMatch(/npx skills add.*completes.*init/i)
    })

    it('skill does not list init-wizard as install path', async () => {
      const skill = await readFile(BUNDLED_SKILL_PATH, 'utf8')
      expect(skill).not.toMatch(/init-wizard/)
    })
  })

  describe('P2-2 doctor/status guide to belay config when floor missing', () => {
    it('doctor advisory mentions belay config (not init-wizard)', async () => {
      const dir = await createTempRepo()
      const report = await doctorProject({ targetDir: dir })
      const text = JSON.stringify(report)
      expect(text).toMatch(/belay config/i)
      expect(text).not.toMatch(/init-wizard/i)
    })

    it('status report guides to belay config when hooks missing', async () => {
      const dir = await createTempRepo()
      const report = await statusProject({ targetDir: dir })
      const text = formatStatusReport(report)
      expect(text).toMatch(/belay config/i)
      expect(text).not.toMatch(/init-wizard/i)
    })
  })

  describe('P2-3 belay config command surface', () => {
    it('cli help documents belay config subcommand', async () => {
      const { stdout } = await execFileAsync('node', [cliPath, '--help'], { cwd: repoRoot })
      expect(stdout).toMatch(/\bbelay config\b/)
    })

    it('config module exports runBelayConfig', async () => {
      const mod = await importConfigModule()
      expect(typeof mod.runBelayConfig).toBe('function')
    })

    it('config module exports interactive default (no subcommand)', async () => {
      const mod = await importConfigModule()
      expect(typeof mod.runBelayConfigInteractive).toBe('function')
    })

    it.each(PLAN_BELAY_CONFIG_SUBCOMMANDS)('config supports subcommand %s', async (sub) => {
      const mod = await importConfigModule()
      expect(mod.BELAY_CONFIG_SUBCOMMANDS).toContain(sub)
    })

    it('belay config set judge.providerId without judge use', async () => {
      const dir = await createTempRepo()
      await initProject({ targetDir: dir, adapter: 'cursor' })
      const mod = await importConfigModule()
      await mod.runBelayConfig({
        targetDir: dir,
        subcommand: 'set',
        path: 'judge.providerId',
        value: 'codex',
      })
      const config = await loadConfigFile(dir)
      expect(config.judge.providerId).toBe('codex')
    })

    it('belay config get returns judge.model', async () => {
      const dir = await createTempRepo()
      await initProject({ targetDir: dir, adapter: 'cursor' })
      const mod = await importConfigModule()
      const value = await mod.runBelayConfig({
        targetDir: dir,
        subcommand: 'get',
        path: 'judge.model',
      })
      expect(String(value)).toMatch(/composer-2\.5/)
    })

    it('belay config judge summarizes judge block', async () => {
      const dir = await createTempRepo()
      await initProject({ targetDir: dir, adapter: 'cursor' })
      const mod = await importConfigModule()
      const summary = await mod.runBelayConfig({ targetDir: dir, subcommand: 'judge' })
      expect(String(summary)).toMatch(/providerId/i)
      expect(String(summary)).toMatch(/credential/i)
    })
  })

  describe('P2-4 credential modes + self-command gate', () => {
    it('allows belay config set judge.providerId under dogfood', async () => {
      const result = await verdict('belay config set judge.providerId cursor', context)
      expect(result.permission).toBe('allow')
      expect(result.reason).toBe('belay_control_plane_command')
    })

    it('allows belay config get judge.model', async () => {
      const result = await verdict('belay config get judge.model', context)
      expect(result.permission).toBe('allow')
    })

    it('allows belay config list', async () => {
      const result = await verdict('belay config list', context)
      expect(result.permission).toBe('allow')
    })

    it('allows belay config unset judge.endpoint', async () => {
      const result = await verdict('belay config unset judge.endpoint', context)
      expect(result.permission).toBe('allow')
    })

    it('rejects belay config set gates.mode', async () => {
      const result = await verdict('belay config set gates.mode enforce', context)
      expect(result.permission).not.toBe('allow')
    })

    it('rejects belay config set policy.mode', async () => {
      const result = await verdict('belay config set policy.mode enforce', context)
      expect(result.permission).not.toBe('allow')
    })

    it('credential subcommand exposed', async () => {
      const mod = await importConfigModule()
      expect(typeof mod.runBelayConfigCredential).toBe('function')
    })

    it('credential mode project via config', async () => {
      const dir = await createTempRepo()
      await initProject({ targetDir: dir, adapter: 'cursor' })
      const mod = await importConfigModule()
      await mod.runBelayConfigCredential({
        targetDir: dir,
        action: 'mode',
        mode: 'project',
      })
      const config = await loadConfigFile(dir)
      expect(config.judge.credential?.mode).toBe('project')
    })

    it('credential set --key-stdin stores api key', async () => {
      const dir = await createTempRepo()
      await initProject({ targetDir: dir, adapter: 'cursor' })
      const { stdout, code } = await new Promise<{ stdout: string; code: number | null }>(
        (resolve, reject) => {
          const child = spawn(
            'node',
            [cliPath, 'config', 'credential', 'set', '--key-stdin', '--target', dir],
            { cwd: repoRoot },
          )
          let out = ''
          child.stdout.on('data', (chunk: Buffer | string) => {
            out += String(chunk)
          })
          child.on('error', reject)
          child.on('close', (exitCode) => resolve({ stdout: out, code: exitCode }))
          child.stdin.write('sk-phase2-stdin-key\n')
          child.stdin.end()
        },
      )
      expect(code).toBe(0)
      expect(stdout).toMatch(/stored/i)
      const config = await loadConfigFile(dir)
      expect(config.judge.credential?.mode).toBe('apiKey')
      expect(config.judge.credential?.ref).toBe('store:judge')
      const stateDir = belayStateDir(config, repoLocalStateDirFor(dir, config))
      expect(await readJudgeCredentialStore(stateDir)).toBe('sk-phase2-stdin-key')
    })

    it('judge status shows credential mode without secret value', async () => {
      const dir = await createTempRepo()
      await initProject({ targetDir: dir, adapter: 'cursor' })
      const status = (await judgeStatus({ targetDir: dir })) as string
      expect(status).toMatch(/credential/i)
      expect(status).toMatch(/project|apiKey/i)
      expect(status).not.toMatch(/sk-[a-z0-9]/i)
    })
  })

  describe('P2-5 init-wizard removed', () => {
    it('cli source does not register init-wizard handler', async () => {
      const cliSource = await readFile(path.join(repoRoot, 'src/cli.ts'), 'utf8')
      expect(cliSource).not.toContain("command === 'init-wizard'")
    })

    it('init-wizard command file is removed', async () => {
      await expect(
        access(path.join(repoRoot, 'src/commands/init-wizard.ts')),
      ).rejects.toMatchObject({ code: 'ENOENT' })
    })

    it('init-wizard unit tests removed or replaced', async () => {
      await expect(
        access(path.join(repoRoot, 'src/__tests__/init-wizard.test.ts')),
      ).rejects.toMatchObject({ code: 'ENOENT' })
    })

    it('invoking init-wizard exits non-zero with belay config hint', async () => {
      await expect(
        execFileAsync('node', [cliPath, 'init-wizard'], { cwd: repoRoot }),
      ).rejects.toMatchObject({
        stderr: expect.stringMatching(/belay config/i),
      })
    })

    it('CHANGELOG documents init-wizard removal', async () => {
      const changelog = await readFile(path.join(repoRoot, 'CHANGELOG.md'), 'utf8')
      expect(changelog).toMatch(/init-wizard/i)
      expect(changelog).toMatch(/belay config/i)
    })
  })

  describe('P2-6 docs: belay config primary, init remains command API', () => {
    it('README does not prescribe belay judge use cursor --endpoint as primary setup', async () => {
      const readme = await readFile(path.join(repoRoot, 'README.md'), 'utf8')
      expect(readme).toMatch(/belay config/i)
      expect(readme).not.toMatch(/belay judge use cursor --endpoint/)
    })

    it('config-schema documents belay config examples', async () => {
      const schema = await readFile(path.join(repoRoot, 'docs/config-schema.md'), 'utf8')
      expect(schema).toMatch(/belay config/i)
    })

    it('cli help still documents non-interactive init', async () => {
      const { stdout } = await execFileAsync('node', [cliPath, '--help'], { cwd: repoRoot })
      expect(stdout).toMatch(/\binit\b/)
      expect(stdout).not.toMatch(/init-wizard/)
    })

    it('README.ja documents belay config', async () => {
      const readmeJa = await readFile(path.join(repoRoot, 'docs/README.ja.md'), 'utf8')
      expect(readmeJa).toMatch(/belay config/i)
    })
  })

  describe('P2-7 init vs config responsibility split', () => {
    it('init remains parameter-driven (no interactive wizard dependency)', async () => {
      const dir = await createTempRepo()
      await expect(
        initProject({ targetDir: dir, adapter: 'cursor', withSkill: false }),
      ).resolves.toBeDefined()
      const config = await loadConfigFile(dir)
      expect(config.judge.providerId).toBe('cursor')
    })

    it('config interactive is separate entrypoint from init', async () => {
      const mod = await importConfigModule()
      expect(mod.runBelayConfig).not.toBe(mod.runInitWizard)
      expect(mod.runInitWizard).toBeUndefined()
    })
  })
})
