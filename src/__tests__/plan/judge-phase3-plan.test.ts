import { mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { judgeStatus, judgeTest } from '../../commands/judge.js'
import { loadConfigFile } from '../../config-io.js'
import { DEFAULT_CONFIG_V4, normalizeConfig } from '../../core/config.js'
import { resolveInitJudgeConfig } from '../../core/judge-config.js'
import { diagnoseJudge } from '../../core/judge-doctor.js'
import { tier1RequiresAsk } from '../../core/verdict/judge.js'
import {
  catalogRequiresEndpoint,
  resolveJudgeFromCatalog,
} from '../../core/verdict/judge-catalog.js'
import { createJudgeFromConfig } from '../../core/verdict/judge-factory.js'
import { initProject, upgradeProject } from '../../installer.js'
import {
  PLAN_CLI_TRANSPORTS,
  PLAN_JUDGE_PROVIDER_IDS,
  PLAN_MODEL_DISCOVERY_SOURCES,
  type PlanCliTransport,
} from './plan-fixtures.js'
import { planProviderIdCast } from './plan-test-helpers.js'

const repoRoot = path.resolve(fileURLToPath(new URL('../../..', import.meta.url)))
const tempDirs: string[] = []

async function createTempRepo() {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'belay-plan-p3-'))
  tempDirs.push(tempDir)
  return tempDir
}

describe('Phase 3 plan — Runtime parity', () => {
  afterEach(async () => {
    vi.unstubAllEnvs()
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
  })

  describe('P3-1 live model discovery', () => {
    it('judge-model-discovery module exists', async () => {
      const mod = await import('../../core/judge-model-discovery.js')
      expect(typeof mod.discoverJudgeModels).toBe('function')
    })

    it.each(
      PLAN_JUDGE_PROVIDER_IDS,
    )('discoverJudgeModels returns source for provider %s', async (providerId) => {
      const { discoverJudgeModels } = await import('../../core/judge-model-discovery.js')
      const result = await discoverJudgeModels({
        providerId,
        model: PLAN_MODEL_DISCOVERY_SOURCES[providerId] === 'ollama-tags' ? 'gemma4:e2b' : 'test',
        endpoint: providerId === 'ollama' ? 'http://127.0.0.1:11434' : null,
      })
      expect(result.source).toBe(PLAN_MODEL_DISCOVERY_SOURCES[providerId])
      expect(Array.isArray(result.modelIds)).toBe(true)
    })

    it('discoverJudgeModels reports found/missing/unverified status', async () => {
      const { checkJudgeModelPresence } = await import('../../core/judge-model-discovery.js')
      const result = await checkJudgeModelPresence({
        providerId: 'cursor',
        model: 'composer-2.5',
        endpoint: null,
      })
      expect(['found', 'missing', 'unverified']).toContain(result.status)
    })

    it('judge test text output includes model check and source', async () => {
      const dir = await createTempRepo()
      await initProject({ targetDir: dir, adapter: 'cursor' })
      const output = (await judgeTest({ targetDir: dir })) as string
      expect(output).toMatch(/Model check:/i)
      expect(output).toMatch(/Model source:/i)
    })

    it('judge test json output includes modelCheck field', async () => {
      const dir = await createTempRepo()
      await initProject({ targetDir: dir, adapter: 'cursor' })
      const output = (await judgeTest({ targetDir: dir, json: true })) as {
        modelCheck?: { status: string; source: string }
      }
      expect(output.modelCheck?.status).toBeTruthy()
      expect(output.modelCheck?.source).toBeTruthy()
    })
  })

  describe('P3-2 keyless native CLI transport', () => {
    it('judge-runtime-detection module exists', async () => {
      const mod = await import('../../core/judge-runtime-detection.js')
      expect(typeof mod.detectJudgeRuntimeCapabilities).toBe('function')
    })

    it('judge-cli module exists for native transports', async () => {
      const mod = await import('../../core/verdict/judge-cli.js')
      expect(typeof mod.createCodexCliJudge).toBe('function')
      expect(typeof mod.createCursorCliJudge).toBe('function')
      expect(typeof mod.createClaudeCliJudge).toBe('function')
    })

    it.each([
      'codex',
      'cursor',
      'claude',
    ] as const)('createJudgeFromConfig selects %s-cli without API key when CLI available', (providerId) => {
      vi.stubEnv('BELAY_DETERMINISTIC_JUDGE', '')
      delete process.env.BELAY_JUDGE_API_KEY
      delete process.env.OPENAI_API_KEY
      delete process.env.CURSOR_API_KEY
      delete process.env.ANTHROPIC_API_KEY

      const catalogJudge = resolveJudgeFromCatalog({
        providerId: planProviderIdCast<Parameters<typeof resolveJudgeFromCatalog>[0]>(providerId),
      })
      const config = normalizeConfig({
        ...DEFAULT_CONFIG_V4,
        judge: {
          ...catalogJudge,
          endpoint: providerId === 'cursor' ? null : catalogJudge.endpoint,
          credential: { mode: 'project' },
        },
      })

      const judge = createJudgeFromConfig(config, { repoRoot: process.cwd() })
      const transport = (judge.lastTrace as { transport?: PlanCliTransport } | undefined)?.transport
      expect(transport).toBe(`${providerId}-cli`)
    })

    it('fail-closed when neither http nor cli transport is available', async () => {
      vi.stubEnv('BELAY_DETERMINISTIC_JUDGE', '')
      delete process.env.BELAY_JUDGE_API_KEY

      const config = normalizeConfig({
        ...DEFAULT_CONFIG_V4,
        judge: {
          ...resolveJudgeFromCatalog({ providerId: 'cursor' }),
          endpoint: null,
          credential: { mode: 'project' },
        },
      })

      const judge = createJudgeFromConfig(config, { repoRoot: process.cwd() })
      const result = await judge.evaluate({
        text: 'git status',
        context: { cwd: process.cwd(), repoRoot: process.cwd() },
      })
      expect(tier1RequiresAsk(result)).toBe(true)
      expect((judge.lastTrace as { transport?: string } | undefined)?.transport).toBeUndefined()
    })
  })

  describe('P3-3 status/doctor show transport and credential source', () => {
    it('judge status includes transport and credential lines', async () => {
      const dir = await createTempRepo()
      await initProject({ targetDir: dir, adapter: 'cursor' })
      const status = (await judgeStatus({ targetDir: dir })) as string
      expect(status).toMatch(/transport\s*:/i)
      expect(status).toMatch(/credential/i)
    })

    it('judge status shows host-session source when applicable', async () => {
      const dir = await createTempRepo()
      await initProject({ targetDir: dir, adapter: 'codex' })
      const status = (await judgeStatus({ targetDir: dir })) as string
      expect(status).toMatch(/host-session|codex-cli|env:/i)
    })

    it('doctor notes include transport', async () => {
      const config = normalizeConfig({
        ...DEFAULT_CONFIG_V4,
        judge: resolveJudgeFromCatalog({
          providerId: planProviderIdCast<Parameters<typeof resolveJudgeFromCatalog>[0]>('codex'),
        }),
      })
      const report = await diagnoseJudge(config, process.cwd())
      expect(report.notes.some((n) => /transport/i.test(n))).toBe(true)
    })

    it('diagnoseJudge reports found model check when discovery deps return models', async () => {
      const config = normalizeConfig({
        ...DEFAULT_CONFIG_V4,
        judge: resolveJudgeFromCatalog({
          providerId: planProviderIdCast<Parameters<typeof resolveJudgeFromCatalog>[0]>('cursor'),
        }),
      })
      const report = await diagnoseJudge(config, process.cwd(), {
        discoveryDeps: {
          allowCliDiscovery: true,
          runCommand: async () => JSON.stringify([{ id: 'composer-2.5' }]),
        },
      })
      expect(report.modelCheck?.status).toBe('found')
      expect(report.notes.some((n) => /Model check: found/i.test(n))).toBe(true)
    })

    it('resolveJudgeCredential exposes sourceKind', async () => {
      const { resolveJudgeCredential } = await import('../../core/judge-api-key.js')
      const config = normalizeConfig({
        ...DEFAULT_CONFIG_V4,
        judge: {
          ...resolveJudgeFromCatalog({ providerId: 'cursor' }),
          credential: { mode: 'project' },
        },
      })
      const result = await resolveJudgeCredential({
        judge: config.judge,
        repoRoot: process.cwd(),
        repoLocalStateDir: path.join(process.cwd(), '.cursor', 'belay'),
        config,
      })
      expect(['env', 'store', 'host-session', 'missing']).toContain(
        (result as { sourceKind?: string }).sourceKind,
      )
    })
  })

  describe('P3-4 transport-aware requiresEndpoint', () => {
    it('ollama never requires endpoint', () => {
      expect(
        (catalogRequiresEndpoint as (id: string, opts?: { transport?: string }) => boolean)(
          'ollama',
        ),
      ).toBe(false)
    })

    it('cursor does not require endpoint when CLI transport is available', () => {
      expect(
        (catalogRequiresEndpoint as (id: 'cursor', opts: { transport: string }) => boolean)(
          'cursor',
          { transport: 'cursor-cli' },
        ),
      ).toBe(false)
    })

    it('cursor requires endpoint for HTTP transport', () => {
      expect(
        (catalogRequiresEndpoint as (id: 'cursor', opts: { transport: string }) => boolean)(
          'cursor',
          { transport: 'http' },
        ),
      ).toBe(true)
    })

    it.each(PLAN_CLI_TRANSPORTS)('transport %s is a valid plan transport label', (transport) => {
      expect(PLAN_CLI_TRANSPORTS).toContain(transport)
    })
  })

  describe('P3-5 opt-in migrate judge default', () => {
    it('init without flag keeps implicit ollama judge', async () => {
      const dir = await createTempRepo()
      await initProject({
        targetDir: dir,
        judgeProviderId: 'local',
        judgeProvider: 'ollama',
      })
      await initProject({ targetDir: dir, adapter: 'cursor' })
      const config = await loadConfigFile(dir)
      expect(config.judge.providerId).toBe('ollama')
    })

    it('init with migrateJudgeDefault moves implicit ollama to host default', async () => {
      const dir = await createTempRepo()
      await initProject({
        targetDir: dir,
        judgeProviderId: 'local',
        judgeProvider: 'ollama',
      })
      await initProject({
        targetDir: dir,
        adapter: 'cursor',
        migrateJudgeDefault: true,
      } as Parameters<typeof initProject>[0] & { migrateJudgeDefault: boolean })
      const config = await loadConfigFile(dir)
      expect(config.judge.providerId).toBe('cursor')
    })

    it('upgrade with migrateJudgeDefault applies migration', async () => {
      const dir = await createTempRepo()
      await initProject({
        targetDir: dir,
        judgeProviderId: 'local',
        judgeProvider: 'ollama',
      })
      await upgradeProject({
        targetDir: dir,
        adapter: 'cursor',
        migrateJudgeDefault: true,
      } as Parameters<typeof upgradeProject>[0] & { migrateJudgeDefault: boolean })
      const config = await loadConfigFile(dir)
      expect(config.judge.providerId).toBe('cursor')
    })

    it('isImplicitLocalJudge helper exists and detects factory default', async () => {
      const judgeConfig = await import('../../core/judge-config.js')
      const isImplicitLocalJudge = (
        judgeConfig as { isImplicitLocalJudge?: (judge: unknown) => boolean }
      ).isImplicitLocalJudge
      expect(typeof isImplicitLocalJudge).toBe('function')
      const judge = resolveJudgeFromCatalog({
        providerId: planProviderIdCast<Parameters<typeof resolveJudgeFromCatalog>[0]>('ollama'),
      })
      expect(isImplicitLocalJudge?.(judge)).toBe(true)
    })

    it('isImplicitLocalJudge is false after explicit judge use', async () => {
      const judgeConfig = await import('../../core/judge-config.js')
      const isImplicitLocalJudge = (
        judgeConfig as { isImplicitLocalJudge?: (judge: unknown) => boolean }
      ).isImplicitLocalJudge
      const judge = {
        ...resolveJudgeFromCatalog({ providerId: 'local' }),
        cloudConsent: { accepted: true, at: 'x', providerId: 'local', endpoint: 'x', by: 'user' },
      }
      expect(isImplicitLocalJudge?.(judge)).toBe(false)
    })
  })

  describe('P3-6 provider-centric policy and docs sync', () => {
    it('getJudgeProviderCapabilities exists for all plan providers', async () => {
      const catalog = await import('../../core/verdict/judge-catalog.js')
      const getJudgeProviderCapabilities = (
        catalog as {
          getJudgeProviderCapabilities?: (id: string) => {
            requiresConsent: boolean
            requiresEndpoint: boolean
            credentialPolicy: string[]
          }
        }
      ).getJudgeProviderCapabilities
      expect(typeof getJudgeProviderCapabilities).toBe('function')
      for (const id of PLAN_JUDGE_PROVIDER_IDS) {
        const caps = getJudgeProviderCapabilities?.(id)
        expect(caps?.credentialPolicy).toContain('project')
      }
    })

    it('diagnoseJudge does not branch on isCloud label', async () => {
      const doctorSource = await readFile(path.join(repoRoot, 'src/core/judge-doctor.ts'), 'utf8')
      expect(doctorSource).not.toMatch(/isCloudProviderId/)
      expect(doctorSource).toMatch(/providerId/)
    })

    it('design doc mentions plan provider ids', async () => {
      const design = await readFile(
        path.join(repoRoot, 'docs/.tmp/judge-provider-switching-ux.md'),
        'utf8',
      )
      for (const id of ['ollama', 'codex', 'claude', 'cursor']) {
        expect(design).toContain(id)
      }
      expect(design).toMatch(/belay config/i)
    })

    it('resolveInitJudgeConfig uses cursor provider for cursor host', () => {
      const judge = resolveInitJudgeConfig({
        isFresh: true,
        hasExplicitJudgeFlags: false,
        adapter: 'cursor',
      })
      expect(judge.providerId).toBe('cursor')
    })
  })
})
