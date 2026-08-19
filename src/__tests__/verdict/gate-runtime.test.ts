import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cursorLayout } from '../../adapters/layouts/cursor.js'
import {
  createDefaultGateRuntimeDeps,
  evaluateGatedAction,
} from '../../adapters/shared/gate-runtime.js'
import { mergeConfig, belayStateDir } from '../../core/config.js'
import { buildShellEffectPlan } from '../../core/effect-ir/index.js'
import * as gateEngine from '../../core/gate-engine.js'
import { standingAllowFile } from '../../core/standing-allow.js'
import { PACKAGE_VERSION } from '../../version.js'

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

  it('records runtime and configuration provenance with each audit event', async () => {
    const repoRoot = await mkdtemp(path.join(os.tmpdir(), 'belay-audit-provenance-'))
    const ctx = gateContext(repoRoot)

    await evaluateGatedAction(ctx, createDefaultGateRuntimeDeps(), {
      kind: 'shell',
      cwd: repoRoot,
      command: 'git status',
    })

    const auditPath = path.join(repoRoot, enforceConfig.audit.logPath)
    const [record] = (await readFile(auditPath, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>)

    expect(record).toMatchObject({
      runtimeVersion: PACKAGE_VERSION,
      runtimeBuildStamp: expect.stringMatching(
        new RegExp(`^${PACKAGE_VERSION.replace(/\./g, '\\.')}@`),
      ),
      configFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
    })
  })

  it('audits distinct effect plans for malformed gated inputs', async () => {
    const repoRoot = await mkdtemp(path.join(os.tmpdir(), 'belay-malformed-gate-'))
    const auditEvents: Record<string, unknown>[] = []
    const deps = createDefaultGateRuntimeDeps()
    const ctx = gateContext(repoRoot)
    const patchedDeps = {
      ...deps,
      async appendAudit(_ctx: typeof ctx, event: Record<string, unknown>) {
        auditEvents.push(event)
      },
    }

    const first = await evaluateGatedAction(ctx, patchedDeps, {
      kind: 'tool',
      cwd: repoRoot,
      toolName: 'MalformedOne',
    })
    const second = await evaluateGatedAction(ctx, patchedDeps, {
      kind: 'tool',
      cwd: repoRoot,
      toolName: 'MalformedTwo',
    })

    expect(first.reason).toBe('normalization_failed')
    expect(second.reason).toBe('normalization_failed')
    expect(first.effectPlan?.inputFingerprint).not.toBe('unnormalized')
    expect(first.effectPlan?.inputFingerprint).not.toBe(second.effectPlan?.inputFingerprint)
    expect(auditEvents[0]).toMatchObject({
      fingerprint: first.effectPlan?.inputFingerprint,
      effectPlanVersion: 1,
      effectPlanDisposition: 'effects',
      effectPlanCompleteness: 'partial',
    })
    expect(auditEvents[0]?.effectIRHash).toBeTypeOf('string')
    expect(auditEvents[0]?.effectIRHash).not.toBe(auditEvents[1]?.effectIRHash)
  })

  it('does not let standing-allow override an authoritative shell EffectPlan', async () => {
    const effectPlan = buildShellEffectPlan({
      inputFingerprint: 'standing-allow-test-fp',
      segments: [
        {
          commandRedacted: 'git status',
          segmentHead: 'git',
          requirements: [
            {
              tag: 'indeterminate',
              action: 'indeterminate',
              resource: { kind: 'unknown' },
              evidence: {
                level: 'indeterminate',
                signals: ['fixture.indeterminate'],
                basis: ['fixture'],
              },
              provenance: { segment: 'git status' },
            },
          ],
          completeness: 'partial',
          opacity: 'opaque',
          signals: ['fixture.indeterminate'],
        },
      ],
    })
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
      effectPlan,
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

    expect(verdict.permission).toBe('deny')
    expect(auditEvents[0]?.reason).not.toBe('standing_allow')
    expect(auditEvents[0]?.standingAllowSource).toBeUndefined()
  })

  it.each([
    { kind: 'tool' as const, label: 'tool' },
    { kind: 'subagent' as const, label: 'subagent' },
  ])('does not let a legacy standing-allow override $label gate decisions', async ({ kind }) => {
    const fingerprint = `${kind}-standing-allow-fp`
    vi.spyOn(gateEngine, 'classifyGatedActionAsync').mockResolvedValue({
      verdict: 'deny_pending_approval',
      reason: 'unknown_local_effect',
      summary: kind === 'tool' ? 'Read' : 'delegate',
      fingerprint,
      assessment: {
        reversibility: 'reversible',
        external: false,
        blastRadius: 'none',
        confidence: 0.5,
        signals: ['unknown_local_effect'],
      },
    })

    const repoRoot = await mkdtemp(path.join(os.tmpdir(), `belay-${kind}-standing-allow-gate-`))
    const configPath = path.join(repoRoot, '.belay', 'config.json')
    await mkdir(path.dirname(configPath), { recursive: true })
    await writeFile(configPath, `${JSON.stringify(enforceConfig, null, 2)}\n`, 'utf8')

    const standingPath = standingAllowFile(
      enforceConfig,
      cursorLayout.repoLocalStateDir(repoRoot),
    )
    await mkdir(belayStateDir(enforceConfig, cursorLayout.repoLocalStateDir(repoRoot)), {
      recursive: true,
    })
    await writeFile(
      standingPath,
      `${JSON.stringify(
        {
          version: 1,
          entries: [
            {
              kind,
              fingerprint,
              source: 'operator',
              reason: 'test',
              createdAt: '2026-01-01T00:00:00.000Z',
              expiresAt: '2099-01-01T00:00:00.000Z',
            },
          ],
        },
        null,
        2,
      )}\n`,
      'utf8',
    )

    const auditEvents: Record<string, unknown>[] = []
    const deps = createDefaultGateRuntimeDeps()
    const ctx = gateContext(repoRoot)
    const patchedDeps = {
      ...deps,
      async appendAudit(_ctx: typeof ctx, event: Record<string, unknown>) {
        auditEvents.push(event)
      },
    }

    const verdict = await evaluateGatedAction(
      ctx,
      patchedDeps,
      kind === 'tool'
        ? { kind, cwd: repoRoot, toolName: 'Read' }
        : { kind, cwd: repoRoot, payload: { prompt: 'delegate' } },
    )

    expect(verdict.permission).toBe('deny')
    expect(auditEvents[0]?.reason).not.toBe('standing_allow')
    expect(auditEvents[0]?.standingAllowSource).toBeUndefined()
  })

  it('blocks rm -rf .git and creates verdict audit trace', async () => {
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
    const snapshot = auditEvents[0]?.actionSnapshot as Record<string, unknown> | undefined
    expect(snapshot?.schemaVersion).toBe(1)
    expect(snapshot?.kind).toBe('shell')
    expect(snapshot?.cwd).toBe(repoRoot)
    expect(snapshot?.normalizedAction).toBeTruthy()
  })

  it('writes actionSnapshot with subdirectory cwd for simulate replay', async () => {
    const repoRoot = await mkdtemp(path.join(os.tmpdir(), 'belay-snapshot-gate-'))
    const srcCwd = path.join(repoRoot, 'src')
    await mkdir(srcCwd, { recursive: true })
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

    await evaluateGatedAction(ctx, patchedDeps, {
      kind: 'shell',
      cwd: srcCwd,
      command: 'rm -rf .git',
    })

    const snapshot = auditEvents[0]?.actionSnapshot as Record<string, unknown> | undefined
    expect(snapshot?.cwd).toBe(srcCwd)
    expect(snapshot?.normalizedAction).toContain('rm')
  })

  it('denies judge infrastructure failures with recovery hints and without approval ids', async () => {
    vi.spyOn(gateEngine, 'classifyGatedActionAsync').mockResolvedValue({
      verdict: 'deny_pending_approval',
      reason: 'tier1_catastrophic',
      summary: 'node --version',
      normalizedCommand: 'node --version',
      fingerprint: 'judge-infra-failure-fp',
      assessment: {
        reversibility: 'reversible',
        external: false,
        blastRadius: 'none',
        confidence: 0.7,
        signals: ['tier1_catastrophic', 'cursor_cli_nonzero'],
      },
      axes: {
        location: 'repo_local',
        opacity: 'transparent',
        effect: 'unknown',
        confidence: 'llm',
        would: 'ask',
        by: 'verdict',
        judgeProvider: 'fallback',
        judgeFallbackReason: 'cursor_cli_nonzero',
      },
    })

    const repoRoot = await mkdtemp(path.join(os.tmpdir(), 'belay-judge-infra-gate-'))
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
      command: 'node --version',
    })

    expect(verdict.permission).toBe('deny')
    expect(verdict.approvalId).toBeUndefined()
    expect(verdict.user_message).toContain('cursor_cli_nonzero')
    expect(verdict.user_message).toContain('agent login')
    expect(verdict.user_message).not.toContain('Approval ID')
    expect(auditEvents[0]?.reason).toBe('judge_transport_unavailable')
    expect(auditEvents[0]?.judgeFallbackReason).toBe('cursor_cli_nonzero')
  })
})
