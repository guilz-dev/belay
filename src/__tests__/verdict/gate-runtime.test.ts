import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cursorLayout } from '../../adapters/layouts/cursor.js'
import {
  createDefaultGateRuntimeDeps,
  evaluateGatedAction,
} from '../../adapters/shared/gate-runtime.js'
import { mergeConfig } from '../../core/config.js'
import * as gateEngine from '../../core/gate-engine.js'
import { createDeterministicJudgeStub } from '../../core/verdict/judge.js'
import * as judgeFactory from '../../core/verdict/judge-factory.js'

describe('gate-runtime integration', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  const enforceConfig = mergeConfig({ mode: 'enforce' })

  function gateContext(repoRoot: string) {
    return {
      layout: cursorLayout,
      repoRoot,
      config: enforceConfig,
      configPath: path.join(repoRoot, '.belay', 'config.json'),
    }
  }

  it('allows git status through verdict engine', async () => {
    vi.spyOn(judgeFactory, 'createJudgeFromConfig').mockReturnValue(createDeterministicJudgeStub())

    const repoRoot = await mkdtemp(path.join(os.tmpdir(), 'belay-verdict-gate-'))
    const configPath = path.join(repoRoot, '.belay', 'config.json')
    await mkdir(path.dirname(configPath), { recursive: true })
    await writeFile(configPath, `${JSON.stringify(enforceConfig, null, 2)}\n`, 'utf8')

    const auditEvents: Record<string, unknown>[] = []
    const deps = createDefaultGateRuntimeDeps()
    const ctx = gateContext(repoRoot)
    const patchedDeps = {
      ...deps,
      async appendAudit(_ctx: typeof ctx, event: Record<string, unknown>) {
        auditEvents.push(event)
      },
    }

    const verdict = await evaluateGatedAction(ctx, patchedDeps, {
      kind: 'shell',
      cwd: repoRoot,
      command: 'git status',
    })

    expect(verdict.permission).toBe('allow')
    expect(verdict.axes?.location).toBe('repo_local')
    expect(auditEvents[0]?.schemaVersion).toBe(2)
    expect(auditEvents[0]?.location).toBe('repo_local')
  })

  it('applies standing-allow when classifier would ask for a provably-benign catalog command', async () => {
    vi.spyOn(judgeFactory, 'createJudgeFromConfig').mockReturnValue(createDeterministicJudgeStub())
    vi.spyOn(gateEngine, 'classifyGatedActionAsync').mockResolvedValue({
      verdict: 'deny_pending_approval',
      reason: 'unknown_local_effect',
      summary: 'git status',
      normalizedCommand: 'git status',
      fingerprint: 'standing-allow-test-fp',
      assessment: {
        reversibility: 'reversible',
        external: false,
        blastRadius: 'none',
        confidence: 0.5,
        signals: ['unknown_local_effect'],
      },
    })

    const repoRoot = await mkdtemp(path.join(os.tmpdir(), 'belay-standing-allow-gate-'))
    const configPath = path.join(repoRoot, '.belay', 'config.json')
    await mkdir(path.dirname(configPath), { recursive: true })
    await writeFile(configPath, `${JSON.stringify(enforceConfig, null, 2)}\n`, 'utf8')

    const auditEvents: Record<string, unknown>[] = []
    const deps = createDefaultGateRuntimeDeps()
    const ctx = gateContext(repoRoot)
    const patchedDeps = {
      ...deps,
      async appendAudit(_ctx: typeof ctx, event: Record<string, unknown>) {
        auditEvents.push(event)
      },
    }

    const verdict = await evaluateGatedAction(ctx, patchedDeps, {
      kind: 'shell',
      cwd: repoRoot,
      command: 'git status',
    })

    expect(verdict.permission).toBe('allow')
    expect(auditEvents[0]?.reason).toBe('standing_allow')
    expect(auditEvents[0]?.standingAllowSource).toBe('provably-benign-corpus')
  })

  it('blocks rm -rf .git and creates verdict audit trace', async () => {
    vi.spyOn(judgeFactory, 'createJudgeFromConfig').mockReturnValue(createDeterministicJudgeStub())

    const repoRoot = await mkdtemp(path.join(os.tmpdir(), 'belay-verdict-gate-'))
    const configPath = path.join(repoRoot, '.belay', 'config.json')
    await mkdir(path.dirname(configPath), { recursive: true })
    await writeFile(configPath, `${JSON.stringify(enforceConfig, null, 2)}\n`, 'utf8')

    const auditEvents: Record<string, unknown>[] = []
    const deps = createDefaultGateRuntimeDeps()
    const ctx = gateContext(repoRoot)
    const patchedDeps = {
      ...deps,
      async appendAudit(_ctx: typeof ctx, event: Record<string, unknown>) {
        auditEvents.push(event)
      },
    }

    const verdict = await evaluateGatedAction(ctx, patchedDeps, {
      kind: 'shell',
      cwd: repoRoot,
      command: 'rm -rf .git',
    })

    expect(verdict.permission).toBe('deny')
    expect(verdict.axes?.would).toBe('ask')
    expect(auditEvents[0]?.effect).toBeDefined()
  })
})
