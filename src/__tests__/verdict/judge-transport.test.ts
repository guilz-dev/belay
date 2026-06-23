import { mkdtemp, readdir, readFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { DEFAULT_CONFIG_V4, scrubOptionsFromConfig } from '../../core/config.js'
import { resetJudgeBrokerForTests } from '../../core/verdict/judge-broker-service.js'
import { buildCliInvocation, CliRunError, createCursorCliJudge } from '../../core/verdict/judge-cli.js'
import { setCliFingerprintResolverForTests } from '../../core/verdict/judge-cli-fingerprint.js'
import {
  DEFAULT_JUDGE_RUNTIME_CONFIG,
  DEFAULT_JUDGE_SESSION_CONFIG,
  DEFAULT_JUDGE_SHADOW_CONFIG,
} from '../../core/verdict/judge-runtime-config.js'
import {
  isJudgeSessionKillSwitchActive,
  recordShadowComparison,
  resetJudgeShadowState,
  setJudgeShadowRandomForTests,
  shouldRunShadowComparison,
} from '../../core/verdict/judge-shadow.js'
import { evaluateWithJudgeTransport } from '../../core/verdict/judge-transport.js'

const SAFE_VERDICT = {
  local_recoverable: true,
  destroys_outside_repo: false,
  destroys_history_or_secrets: false,
  reason: 'safe',
}

const SAFE_VERDICT_JSON = JSON.stringify(SAFE_VERDICT)

describe('judge-transport', () => {
  beforeEach(() => {
    resetJudgeBrokerForTests()
    resetJudgeShadowState()
    setCliFingerprintResolverForTests(async () => 'test-cli-1.0.0')
    setJudgeShadowRandomForTests(() => 1)
  })

  it('uses spawn path when session transport is disabled', async () => {
    let calls = 0
    const result = await evaluateWithJudgeTransport(
      {
        prompt: 'judge prompt',
        context: {
          providerId: 'cursor',
          model: 'composer-2.5',
          repoRoot: '/repo/a',
          stateDir: '/tmp/belay-state-a',
          judgeMode: 'audit',
          runtime: DEFAULT_JUDGE_RUNTIME_CONFIG,
          judgeTimeoutMs: 5_000,
        },
      },
      {
        runCommand: async () => {
          calls += 1
          return SAFE_VERDICT_JSON
        },
      },
    )

    expect(calls).toBe(1)
    expect(result.transport).toBe('spawn')
    expect(result.verdict).toEqual(SAFE_VERDICT)
  })

  it('falls back to spawn on parse failure (fail-closed)', async () => {
    let calls = 0
    const result = await evaluateWithJudgeTransport(
      {
        prompt: 'judge prompt',
        context: {
          providerId: 'cursor',
          model: 'composer-2.5',
          repoRoot: '/repo/b',
          stateDir: '/tmp/belay-state-b',
          judgeMode: 'audit',
          runtime: {
            session: { ...DEFAULT_JUDGE_SESSION_CONFIG, enabled: true },
            shadow: { ...DEFAULT_JUDGE_SHADOW_CONFIG },
          },
          judgeTimeoutMs: 5_000,
        },
      },
      {
        runCommand: async () => {
          calls += 1
          return calls === 1 ? 'not-json' : SAFE_VERDICT_JSON
        },
      },
    )

    expect(calls).toBe(2)
    expect(result.fallbackReason).toBe('non_json_response')
    expect(result.verdict).toEqual(SAFE_VERDICT)
  })

  it('triggers kill switch when shadow mismatch rate exceeds threshold', async () => {
    setJudgeShadowRandomForTests(() => 0)
    const stateDir = await mkdtemp(path.join(os.tmpdir(), 'belay-kill-'))
    const runtime = {
      session: { ...DEFAULT_JUDGE_SESSION_CONFIG, enabled: true },
      shadow: {
        ...DEFAULT_JUDGE_SHADOW_CONFIG,
        enabled: true,
        sampleRate: 1,
        mismatchRateThreshold: 0,
        windowSize: 1,
      },
    }

    const mismatchVerdict = {
      ...SAFE_VERDICT,
      local_recoverable: false,
      reason: 'unsafe',
    }

    let calls = 0
    await evaluateWithJudgeTransport(
      {
        prompt: 'judge prompt',
        context: {
          providerId: 'cursor',
          model: 'composer-2.5',
          repoRoot: '/repo/c',
          stateDir,
          judgeMode: 'audit',
          runtime,
          judgeTimeoutMs: 5_000,
        },
      },
      {
        runCommand: async () => {
          calls += 1
          return calls === 1 ? SAFE_VERDICT_JSON : JSON.stringify(mismatchVerdict)
        },
      },
    )

    expect(await isJudgeSessionKillSwitchActive('/repo/c', stateDir)).toBe(true)
  })

  it('rejects broken JSON and CLI hang via spawn fallback (chaos)', async () => {
    const judge = createCursorCliJudge({
      modelRequested: 'composer-2.5',
      modelResolved: 'composer-2.5',
      sensitivePaths: DEFAULT_CONFIG_V4.classifier.sensitivePaths,
      scrubOptions: scrubOptionsFromConfig(DEFAULT_CONFIG_V4),
      runtime: {
        session: { ...DEFAULT_JUDGE_SESSION_CONFIG, enabled: true },
        shadow: { ...DEFAULT_JUDGE_SHADOW_CONFIG },
      },
      repoRoot: '/repo/d',
      stateDir: '/tmp/belay-state-d',
      judgeMode: 'audit',
      runCliCommand: async () => {
        throw new Error('hang')
      },
    })

    const verdict = await judge.evaluate({
      text: 'rm -rf .git',
      context: { cwd: '/repo/d', repoRoot: '/repo/d' },
    })
    expect(verdict.reason).toBe('cursor_cli_unavailable')
  })

  it('keeps fallback observable when CLI exits non-zero', async () => {
    const judge = createCursorCliJudge({
      modelRequested: 'composer-2.5',
      modelResolved: 'composer-2.5',
      sensitivePaths: DEFAULT_CONFIG_V4.classifier.sensitivePaths,
      scrubOptions: scrubOptionsFromConfig(DEFAULT_CONFIG_V4),
      runtime: {
        session: { ...DEFAULT_JUDGE_SESSION_CONFIG, enabled: false },
        shadow: { ...DEFAULT_JUDGE_SHADOW_CONFIG },
      },
      repoRoot: '/repo/nonzero',
      stateDir: '/tmp/belay-state-nonzero',
      judgeMode: 'audit',
      runCliCommand: async () => {
        throw new CliRunError('exit_nonzero', 'unsupported option', {
          exitCode: 2,
          stderr: 'unsupported option',
        })
      },
    })

    const verdict = await judge.evaluate({
      text: 'git status',
      context: { cwd: '/repo/nonzero', repoRoot: '/repo/nonzero' },
    })

    expect(verdict.reason).toBe('cursor_cli_unavailable')
    expect(judge.lastTrace?.judgeFallbackReason).toBe('cursor_cli_nonzero')
  })

  it('does not persist session prompt or chat id under state dir', async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), 'belay-session-persist-'))
    const secretPrompt = 'super-secret-tier1-prompt-token'
    const chatId = 'chat-secret-999'

    await evaluateWithJudgeTransport(
      {
        prompt: secretPrompt,
        context: {
          providerId: 'cursor',
          model: 'composer-2.5',
          repoRoot: '/repo/e',
          stateDir,
          judgeMode: 'audit',
          runtime: {
            session: { ...DEFAULT_JUDGE_SESSION_CONFIG, enabled: true },
            shadow: { ...DEFAULT_JUDGE_SHADOW_CONFIG },
          },
          judgeTimeoutMs: 5_000,
        },
      },
      {
        runCommand: async () =>
          JSON.stringify({
            ...SAFE_VERDICT,
            chat_id: chatId,
          }),
      },
    )

    const files = await listFilesRecursive(stateDir)
    for (const file of files) {
      const content = await readFile(file, 'utf8')
      expect(content.includes(secretPrompt)).toBe(false)
      expect(content.includes(chatId)).toBe(false)
    }
  })

  it('stops shadow comparisons after daily cap is reached', () => {
    setJudgeShadowRandomForTests(() => 0)
    const runtime = {
      session: { ...DEFAULT_JUDGE_SESSION_CONFIG, enabled: true },
      shadow: {
        ...DEFAULT_JUDGE_SHADOW_CONFIG,
        enabled: true,
        sampleRate: 1,
        dailyRequestCap: 1,
      },
    }
    expect(shouldRunShadowComparison('/repo/f', 'cursor', runtime.shadow)).toBe(true)
    recordShadowComparison('/repo/f', runtime.shadow, false)
    expect(shouldRunShadowComparison('/repo/f', 'cursor', runtime.shadow)).toBe(false)
  })

  it('forces new session after cli version fingerprint changes', async () => {
    let version = '1.0.0'
    setCliFingerprintResolverForTests(async () => version)
    const stateDir = '/tmp/belay-state-version'
    const runtime = {
      session: { ...DEFAULT_JUDGE_SESSION_CONFIG, enabled: true },
      shadow: { ...DEFAULT_JUDGE_SHADOW_CONFIG },
    }
    let calls = 0
    await evaluateWithJudgeTransport(
      {
        prompt: 'judge prompt',
        context: {
          providerId: 'cursor',
          model: 'composer-2.5',
          repoRoot: '/repo/version',
          stateDir,
          judgeMode: 'audit',
          runtime,
          judgeTimeoutMs: 5_000,
        },
      },
      {
        runCommand: async () => {
          calls += 1
          return SAFE_VERDICT_JSON
        },
      },
    )
    version = '2.0.0'
    const second = await evaluateWithJudgeTransport(
      {
        prompt: 'judge prompt',
        context: {
          providerId: 'cursor',
          model: 'composer-2.5',
          repoRoot: '/repo/version',
          stateDir,
          judgeMode: 'audit',
          runtime,
          judgeTimeoutMs: 5_000,
        },
      },
      {
        runCommand: async () => {
          calls += 1
          return SAFE_VERDICT_JSON
        },
      },
    )
    expect(calls).toBeGreaterThanOrEqual(2)
    expect(second.sessionReused).toBe(false)
  })

  it('handles broken JSON envelopes via spawn fallback', async () => {
    const broken = JSON.stringify({ type: 'result', message: 'not-a-verdict' })
    let calls = 0
    const result = await evaluateWithJudgeTransport(
      {
        prompt: 'judge prompt',
        context: {
          providerId: 'cursor',
          model: 'composer-2.5',
          repoRoot: '/repo/broken',
          stateDir: '/tmp/belay-state-broken',
          judgeMode: 'audit',
          runtime: {
            session: { ...DEFAULT_JUDGE_SESSION_CONFIG, enabled: true },
            shadow: { ...DEFAULT_JUDGE_SHADOW_CONFIG },
          },
          judgeTimeoutMs: 5_000,
        },
      },
      {
        runCommand: async () => {
          calls += 1
          return calls === 1 ? broken : SAFE_VERDICT_JSON
        },
      },
    )
    expect(calls).toBe(2)
    expect(result.fallbackReason).toBe('parse_error')
    expect(result.verdict).toEqual(SAFE_VERDICT)
  })

  it('enforces read-only cursor invocation args', () => {
    const invocation = buildCliInvocation('cursor', 'prompt', 'composer-2.5')
    expect(invocation.args).toContain('--sandbox')
    expect(invocation.args).toContain('enabled')
    expect(invocation.args).toContain('--mode')
    expect(invocation.args).toContain('ask')
  })
})

async function listFilesRecursive(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true })
  const files: string[] = []
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      files.push(...(await listFilesRecursive(fullPath)))
    } else {
      files.push(fullPath)
    }
  }
  return files
}
