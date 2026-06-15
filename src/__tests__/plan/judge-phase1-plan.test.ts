import { access, mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { judgeList } from '../../commands/judge.js'
import { loadConfigFile } from '../../config-io.js'
import { DEFAULT_CONFIG_V4, normalizeConfig } from '../../core/config.js'
import {
  defaultJudgeProviderForAdapter,
  JUDGE_PROFILE_CLAUDE,
  JUDGE_PROFILE_CODEX,
  resolveInitJudgeConfig,
  resolveJudgeConfig,
} from '../../core/judge-config.js'
import { diagnoseJudge } from '../../core/judge-doctor.js'
import {
  JUDGE_CATALOG,
  JUDGE_PROVIDER_IDS,
  resolveJudgeFromCatalog,
} from '../../core/verdict/judge-catalog.js'
import { initProject } from '../../installer.js'
import {
  PLAN_DEFAULT_MODELS,
  PLAN_HOST_DEFAULT_PROVIDER,
  PLAN_JUDGE_PROVIDER_IDS,
  PLAN_LEGACY_READ_ALIASES,
  PLAN_PROVIDER_ADAPTERS,
  PLAN_REMOVED_PROVIDER_IDS,
  PLAN_TERMINOLOGY,
} from './plan-fixtures.js'
import { combinedDoctorText, planProviderIdCast } from './plan-test-helpers.js'

const repoRoot = path.resolve(fileURLToPath(new URL('../../..', import.meta.url)))
const tempDirs: string[] = []
const BUNDLED_SKILL_PATH = new URL('../../../skills/belay/SKILL.md', import.meta.url)

async function createTempRepo() {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'belay-plan-p1-'))
  tempDirs.push(tempDir)
  return tempDir
}

describe('Phase 1 plan — Foundation', () => {
  afterEach(async () => {
    vi.unstubAllEnvs()
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
  })

  describe('P1-1 fresh init uses catalog default models (no gpt-4.1-mini / auto)', () => {
    it.each([
      'cursor',
      'claude',
      'codex',
    ] as const)('fresh init host %s uses plan default model and providerId', async (host) => {
      const repoRoot = await createTempRepo()
      await initProject({ targetDir: repoRoot, adapter: host })
      const config = await loadConfigFile(repoRoot)
      const providerId = PLAN_HOST_DEFAULT_PROVIDER[host]
      expect(config.judge.providerId).toBe(providerId)
      expect(config.judge.model).toBe(PLAN_DEFAULT_MODELS[providerId])
      expect(config.judge.model).not.toBe('auto')
      expect(config.judge.model).not.toBe('gpt-4.1-mini')
    })

    it('resolveJudgeFromCatalog pins plan default models for all providers', () => {
      for (const providerId of PLAN_JUDGE_PROVIDER_IDS) {
        const resolved = resolveJudgeFromCatalog({
          providerId: planProviderIdCast<Parameters<typeof resolveJudgeFromCatalog>[0]>(providerId),
        })
        expect(resolved.model).toBe(PLAN_DEFAULT_MODELS[providerId])
      }
    })

    it('normalizeConfig migrates judge.model auto to catalog default on load', () => {
      const loaded = normalizeConfig({
        ...DEFAULT_CONFIG_V4,
        judge: {
          ...DEFAULT_CONFIG_V4.judge,
          providerId: 'codex' as (typeof DEFAULT_CONFIG_V4.judge)['providerId'],
          provider: 'openai-compatible',
          model: 'auto',
        },
      })
      expect(loaded.judge.model).toBe(PLAN_DEFAULT_MODELS.codex)
      expect(loaded.judge.model).not.toBe('gpt-4.1-mini')
    })

    it('fresh init never writes judge.model auto', async () => {
      for (const host of ['cursor', 'claude', 'codex'] as const) {
        const dir = await createTempRepo()
        await initProject({ targetDir: dir, adapter: host })
        const config = await loadConfigFile(dir, host)
        expect(config.judge.model).not.toBe('auto')
      }
    })
  })

  describe('P1-2 providerId rename (no new openai/local writes; read aliases)', () => {
    it('catalog lists exactly four plan providers', () => {
      expect([...JUDGE_PROVIDER_IDS].sort()).toEqual([...PLAN_JUDGE_PROVIDER_IDS].sort())
      for (const removed of PLAN_REMOVED_PROVIDER_IDS) {
        expect(JUDGE_PROVIDER_IDS).not.toContain(removed)
      }
    })

    it('defaultJudgeProviderForAdapter maps claude/codex to claude/codex (not openai)', () => {
      expect(defaultJudgeProviderForAdapter('claude')).toBe('claude')
      expect(defaultJudgeProviderForAdapter('codex')).toBe('codex')
      expect(defaultJudgeProviderForAdapter('cursor')).toBe('cursor')
    })

    it('normalizes legacy providerId aliases on load', () => {
      for (const [legacy, canonical] of Object.entries(PLAN_LEGACY_READ_ALIASES)) {
        const loaded = normalizeConfig({
          ...DEFAULT_CONFIG_V4,
          judge: {
            ...DEFAULT_CONFIG_V4.judge,
            providerId: legacy as never,
          },
        })
        expect(loaded.judge.providerId).toBe(canonical)
      }
    })

    it('fresh init writes canonical providerId only for all hosts', async () => {
      for (const host of ['cursor', 'claude', 'codex'] as const) {
        const dir = await createTempRepo()
        await initProject({ targetDir: dir, adapter: host })
        const config = await loadConfigFile(dir, host)
        expect(config.judge.providerId).toBe(PLAN_HOST_DEFAULT_PROVIDER[host])
        expect(config.judge.providerId).not.toBe('openai')
        expect(config.judge.providerId).not.toBe('local')
      }
    })

    it('openrouter is removed from active catalog', () => {
      expect(JUDGE_PROVIDER_IDS).not.toContain('openrouter')
      expect(JUDGE_PROVIDER_IDS).not.toContain('custom')
    })

    it('claude profile does not point at api.openai.com', () => {
      expect(JUDGE_PROFILE_CLAUDE.endpoint ?? '').not.toContain('api.openai.com')
      expect(JUDGE_PROFILE_CODEX.endpoint).not.toBe('https://api.openai.com/v1')
    })
  })

  describe('P1-3 belay judge list exposes four providers only', () => {
    it('catalog keys match plan provider set', () => {
      expect(Object.keys(JUDGE_CATALOG).sort()).toEqual([...PLAN_JUDGE_PROVIDER_IDS].sort())
    })

    it('judge list command lists only plan providers', () => {
      const listing = judgeList() as string
      for (const id of PLAN_JUDGE_PROVIDER_IDS) {
        expect(listing).toContain(id)
      }
      for (const removed of PLAN_REMOVED_PROVIDER_IDS) {
        expect(listing).not.toContain(removed)
      }
      expect(listing).not.toContain('local\n')
      expect(listing).not.toContain('openai ')
    })

    it('judge list defaultModel column matches plan', () => {
      const entries = judgeList({ json: true }) as Array<{
        id: string
        defaultModel: string
      }>
      for (const entry of entries) {
        const planId = entry.id as keyof typeof PLAN_DEFAULT_MODELS
        if (planId in PLAN_DEFAULT_MODELS) {
          expect(entry.defaultModel).toBe(PLAN_DEFAULT_MODELS[planId])
        }
      }
    })
  })

  describe('P1-4 doctor does not probe Ollama when judge is not ollama', () => {
    it.each([
      'cursor',
      'claude',
      'codex',
    ] as const)('fresh %s init: doctor omits Ollama probe', async (host) => {
      const dir = await createTempRepo()
      await initProject({ targetDir: dir, adapter: host })
      const config = await loadConfigFile(dir)
      const report = await diagnoseJudge(config, dir)
      const combined = combinedDoctorText(report)
      expect(combined).not.toContain('Ollama endpoint:')
      expect(combined.toLowerCase()).not.toMatch(/ollama.*unreachable/)
    })
  })

  describe('P1-5 re-init preserves cursor judge without endpoint', () => {
    it('second init does not throw when cursor endpoint is null', async () => {
      const dir = await createTempRepo()
      await initProject({ targetDir: dir, adapter: 'cursor' })
      await expect(initProject({ targetDir: dir, adapter: 'cursor' })).resolves.toBeDefined()
      const config = await loadConfigFile(dir)
      expect(config.judge.providerId).toBe('cursor')
      expect(config.judge.endpoint).toBeNull()
    })

    it('resolveInitJudgeConfig keeps existing cursor judge without endpoint', () => {
      const existing = resolveJudgeFromCatalog({ providerId: 'cursor' })
      const resolved = resolveInitJudgeConfig({
        isFresh: false,
        hasExplicitJudgeFlags: false,
        existingJudge: { ...existing, endpoint: null },
        adapter: 'cursor',
      })
      expect(resolved.providerId).toBe('cursor')
      expect(resolved.endpoint).toBeNull()
    })

    it('applies BELAY_JUDGE_ENDPOINT on fresh init when set', async () => {
      vi.stubEnv('BELAY_JUDGE_ENDPOINT', 'https://judge.example.com/v1')
      const dir = await createTempRepo()
      await initProject({ targetDir: dir, adapter: 'cursor' })
      const config = await loadConfigFile(dir)
      expect(config.judge.endpoint).toBe('https://judge.example.com/v1')
    })
  })

  describe('P1-6 bundled skill template exists for --with-skill', () => {
    it('skills/belay/SKILL.md is present in the published bundle path', async () => {
      await expect(access(fileURLToPath(BUNDLED_SKILL_PATH))).resolves.toBeUndefined()
    })

    it('init --with-skill installs bundled skill without error', async () => {
      const dir = await createTempRepo()
      await expect(initProject({ targetDir: dir, withSkill: true })).resolves.toBeDefined()
      const installed = path.join(dir, '.cursor', 'skills', 'belay', 'SKILL.md')
      await expect(access(installed)).resolves.toBeUndefined()
    })
  })

  describe('P1-7 host → provider mapping', () => {
    it.each([
      'cursor',
      'claude',
      'codex',
    ] as const)('fresh init adapter %s uses plan providerId', async (host) => {
      const dir = await createTempRepo()
      await initProject({ targetDir: dir, adapter: host })
      const config = await loadConfigFile(dir)
      expect(config.judge.providerId).toBe(PLAN_HOST_DEFAULT_PROVIDER[host])
    })

    it('resolveInitJudgeConfig maps each host to plan provider', () => {
      for (const host of ['cursor', 'claude', 'codex'] as const) {
        const judge = resolveInitJudgeConfig({
          isFresh: true,
          hasExplicitJudgeFlags: false,
          adapter: host,
        })
        expect(judge.providerId).toBe(PLAN_HOST_DEFAULT_PROVIDER[host])
      }
    })
  })

  describe('P1-8 terminology contract (docs only; JSON keys unchanged)', () => {
    it('README distinguishes provider, adapter (driver), and host', async () => {
      const readme = await readFile(path.join(repoRoot, 'README.md'), 'utf8')
      expect(readme).toMatch(/provider/i)
      expect(readme).toMatch(/adapter|driver/i)
      expect(readme).toMatch(/host|config\.adapter/i)
    })

    it('config-schema documents plan provider ids', async () => {
      const schema = await readFile(path.join(repoRoot, 'docs/config-schema.md'), 'utf8')
      for (const id of PLAN_JUDGE_PROVIDER_IDS) {
        expect(schema).toContain(id)
      }
      expect(schema).toContain(PLAN_TERMINOLOGY.provider)
    })
  })

  describe('P1-9 provider → adapter derivation', () => {
    it('catalog driver matches plan adapter map when provider exists', () => {
      for (const providerId of PLAN_JUDGE_PROVIDER_IDS) {
        expect(JUDGE_PROVIDER_IDS).toContain(providerId)
        const spec = JUDGE_CATALOG[providerId as keyof typeof JUDGE_CATALOG]
        expect(spec.driver).toBe(PLAN_PROVIDER_ADAPTERS[providerId])
      }
    })

    it('claude driver is not openai-compatible pointed at openai.com', () => {
      const claude = resolveJudgeFromCatalog({
        providerId: planProviderIdCast<Parameters<typeof resolveJudgeFromCatalog>[0]>('claude'),
      })
      if (claude.provider === 'openai-compatible') {
        expect(claude.endpoint).not.toContain('api.openai.com')
      } else {
        expect(claude.provider).toBe('anthropic')
      }
    })
  })

  describe('P1-10 fresh init credential and consent baseline', () => {
    it('writes credential.mode project on fresh init', async () => {
      const dir = await createTempRepo()
      await initProject({ targetDir: dir, adapter: 'cursor' })
      const config = await loadConfigFile(dir)
      expect(config.judge.credential?.mode).toBe('project')
    })

    it('resolveJudgeConfig with explicit ollama uses ollama adapter', () => {
      const judge = resolveJudgeConfig({
        judgeProviderId: 'ollama' as Parameters<typeof resolveJudgeConfig>[0] extends {
          judgeProviderId?: infer I
        }
          ? I
          : never,
      })
      expect(judge.provider).toBe('ollama')
      expect(judge.providerId).toBe('ollama')
    })
  })
})
