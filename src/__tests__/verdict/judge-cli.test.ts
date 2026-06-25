import { describe, expect, it } from 'vitest'
import type { TracedTier1Judge } from '../../core/verdict/judge.js'
import {
  buildCliInvocation,
  type CliInvocation,
  type CliJudgeOptions,
  CliRunError,
  createClaudeCliJudge,
  createCodexCliJudge,
  createCursorCliJudge,
  parseCliJudgeOutput,
  runCliJsonWithTimeouts,
} from '../../core/verdict/judge-cli.js'
import type { Tier1Verdict } from '../../core/verdict/types.js'

const SAFE_VERDICT = {
  local_recoverable: true,
  destroys_outside_repo: false,
  destroys_history_or_secrets: false,
  reason: 'safe',
}

const SAFE_VERDICT_JSON = JSON.stringify(SAFE_VERDICT)

describe('judge-cli', () => {
  describe('buildCliInvocation', () => {
    it('uses read-only codex exec over stdin', () => {
      const invocation = buildCliInvocation('codex', 'judge prompt', 'gpt-5-codex')
      expect(invocation).toEqual({
        binary: 'codex',
        args: [
          'exec',
          '--json',
          '--skip-git-repo-check',
          '--sandbox',
          'read-only',
          '--model',
          'gpt-5-codex',
          '-',
        ],
        stdin: 'judge prompt',
      })
    })

    it('uses read-only cursor ask mode', () => {
      const invocation = buildCliInvocation('cursor', 'judge prompt', 'composer-2.5')
      expect(invocation.binary).toBe('cursor-agent')
      expect(invocation.args).toContain('--mode')
      expect(invocation.args).toContain('ask')
      expect(invocation.args).toContain('--sandbox')
      expect(invocation.args).toContain('enabled')
      expect(invocation.args).toContain('--trust')
      expect(invocation.stdin).toBeUndefined()
    })

    it('uses claude print mode with tools disabled', () => {
      const invocation = buildCliInvocation('claude', 'judge prompt', 'claude-sonnet-4-6')
      expect(invocation).toEqual({
        binary: 'claude',
        args: [
          '-p',
          '--output-format',
          'json',
          '--permission-mode',
          'plan',
          '--tools',
          '',
          '--bare',
          '--model',
          'claude-sonnet-4-6',
        ],
        stdin: 'judge prompt',
      })
    })
  })

  describe('parseCliJudgeOutput', () => {
    it('parses a direct verdict JSON payload', () => {
      expect(parseCliJudgeOutput('claude', SAFE_VERDICT_JSON)).toEqual(SAFE_VERDICT)
    })

    it('parses claude single-result envelope output', () => {
      const raw = JSON.stringify({
        type: 'result',
        subtype: 'success',
        result: SAFE_VERDICT_JSON,
      })
      expect(parseCliJudgeOutput('claude', raw)).toEqual(SAFE_VERDICT)
    })

    it('parses cursor nested JSON envelope output', () => {
      const raw = JSON.stringify({
        type: 'result',
        message: {
          role: 'assistant',
          content: SAFE_VERDICT_JSON,
        },
      })
      expect(parseCliJudgeOutput('cursor', raw)).toEqual(SAFE_VERDICT)
    })

    it('parses codex JSONL output by reading the final assistant event', () => {
      const raw = [
        JSON.stringify({ provider: 'openai', model: 'gpt-5-codex' }),
        JSON.stringify({ prompt: 'judge prompt' }),
        JSON.stringify({
          type: 'assistant',
          message: {
            content: [
              {
                type: 'output_text',
                text: SAFE_VERDICT_JSON,
              },
            ],
          },
        }),
      ].join('\n')
      expect(parseCliJudgeOutput('codex', raw)).toEqual(SAFE_VERDICT)
    })
  })

  describe('evaluate', () => {
    const baseOptions = {
      modelRequested: 'judge-model',
      modelResolved: 'judge-model',
      sensitivePaths: ['.env'],
      scrubOptions: {},
      timeoutMs: 1000,
    }

    async function runWithJudge(
      createJudge: (options: Omit<CliJudgeOptions, 'providerId'>) => TracedTier1Judge,
      raw: string,
    ): Promise<{ result: Tier1Verdict; seenInvocation: CliInvocation | null }> {
      let seenInvocation: CliInvocation | null = null
      const judge = createJudge({
        ...baseOptions,
        runCliCommand: async (invocation) => {
          seenInvocation = invocation
          return raw
        },
      })
      const result = await judge.evaluate({
        text: 'mystery-cli deploy',
        context: { cwd: '/repo', repoRoot: '/repo' },
      })
      return { result, seenInvocation }
    }

    it('parses codex CLI output through evaluate', async () => {
      const raw = `${JSON.stringify({ type: 'assistant', result: SAFE_VERDICT_JSON })}\n`
      const { result, seenInvocation } = await runWithJudge(createCodexCliJudge, raw)
      expect(result).toEqual(SAFE_VERDICT)
      expect(seenInvocation?.args).toContain('read-only')
    })

    it('parses cursor CLI output through evaluate', async () => {
      const raw = JSON.stringify({ type: 'result', result: SAFE_VERDICT_JSON })
      const { result, seenInvocation } = await runWithJudge(createCursorCliJudge, raw)
      expect(result).toEqual(SAFE_VERDICT)
      expect(seenInvocation?.args).toContain('ask')
    })

    it('parses claude CLI output through evaluate', async () => {
      const raw = JSON.stringify({ type: 'result', result: SAFE_VERDICT_JSON })
      const { result, seenInvocation } = await runWithJudge(createClaudeCliJudge, raw)
      expect(result).toEqual(SAFE_VERDICT)
      expect(seenInvocation?.args).toContain('--tools')
    })

    it('times out promptly when child ignores SIGTERM', async () => {
      const started = Date.now()
      try {
        await runCliJsonWithTimeouts(
          {
            binary: process.execPath,
            args: ['-e', 'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000)'],
          },
          { evalTimeoutMs: 100 },
        )
      } catch (error) {
        const cliError = error as CliRunError
        expect(cliError).toBeInstanceOf(CliRunError)
        expect(cliError.kind).toBe('timeout')
        expect(Date.now() - started).toBeLessThan(700)
        return
      }
      throw new Error('expected timeout rejection')
    })
  })
})
