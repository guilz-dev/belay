import { spawn } from 'node:child_process'

import type { ScrubOptions } from '../types.js'
import { scrubOutboundForJudge } from './judge-outbound.js'
import {
  buildTier1Prompt,
  parseTier1Json,
  prescanInterpreterCode,
  type Tier1JudgeTrace,
  type Tier1JudgeTransport,
  type TracedTier1Judge,
} from './judge.js'
import type { JudgeProviderId } from './judge-catalog.js'

export interface CliJudgeOptions {
  providerId: JudgeProviderId
  modelRequested: string
  modelResolved: string
  timeoutMs?: number
  sensitivePaths: string[]
  scrubOptions: ScrubOptions
}

const CLI_BINARIES: Record<Exclude<JudgeProviderId, 'ollama'>, string> = {
  codex: 'codex',
  cursor: 'cursor-agent',
  claude: 'claude',
}

function failClosedVerdict(reason: string) {
  return {
    local_recoverable: false,
    destroys_outside_repo: true,
    destroys_history_or_secrets: true,
    external_change: true,
    reason,
  }
}

function transportForProvider(providerId: JudgeProviderId): Tier1JudgeTransport {
  return `${providerId}-cli` as Tier1JudgeTransport
}

function traceProvider(providerId: JudgeProviderId): Tier1JudgeTrace['provider'] {
  if (providerId === 'claude') {
    return 'anthropic'
  }
  return 'openai-compatible'
}

function initialTrace(options: CliJudgeOptions): Tier1JudgeTrace {
  return {
    provider: traceProvider(options.providerId),
    modelRequested: options.modelRequested,
    modelResolved: options.modelResolved,
    latencyMs: 0,
    transport: transportForProvider(options.providerId),
  }
}

async function runCliJson(
  providerId: Exclude<JudgeProviderId, 'ollama'>,
  prompt: string,
  model: string,
  timeoutMs: number,
): Promise<string> {
  const binary = CLI_BINARIES[providerId]
  const args =
    providerId === 'codex'
      ? ['exec', '--json', '--model', model, '--', prompt]
      : providerId === 'cursor'
        ? ['--print', '--output-format', 'json', '--model', model, prompt]
        : ['-p', '--output-format', 'json', '--model', model, prompt]
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => {
      child.kill('SIGTERM')
      reject(new Error(`${binary} timed out`))
    }, timeoutMs)
    child.stdout.on('data', (chunk) => {
      stdout += String(chunk)
    })
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk)
    })
    child.on('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      if (code === 0 && stdout.trim()) {
        resolve(stdout.trim())
        return
      }
      reject(new Error(stderr.trim() || `${binary} exited with code ${code ?? 'unknown'}`))
    })
  })
}

function createCliJudge(options: CliJudgeOptions): TracedTier1Judge {
  const transport = transportForProvider(options.providerId)
  const timeoutMs = options.timeoutMs ?? 25000
  const providerId = options.providerId as Exclude<JudgeProviderId, 'ollama'>

  const judge: TracedTier1Judge = {
    lastTrace: initialTrace(options),
    async evaluate(input) {
      const started = Date.now()
      const prescan = input.innerCode ? prescanInterpreterCode(input.innerCode) : null
      if (prescan?.destroys_history_or_secrets) {
        judge.lastTrace = {
          provider: traceProvider(options.providerId),
          modelRequested: options.modelRequested,
          modelResolved: options.modelResolved,
          latencyMs: Date.now() - started,
          transport,
        }
        return prescan
      }

      const scrubbed = scrubOutboundForJudge(input.text, {
        sensitivePaths: options.sensitivePaths,
        scrubOptions: options.scrubOptions,
      })
      if (!scrubbed.ok) {
        judge.lastTrace = {
          provider: 'fallback',
          modelRequested: options.modelRequested,
          modelResolved: options.modelResolved,
          latencyMs: Date.now() - started,
          fallbackReason: scrubbed.reason,
        }
        return failClosedVerdict('outbound_scrub_failed')
      }

      const prompt = buildTier1Prompt(scrubbed.text)
      try {
        const raw = await runCliJson(providerId, prompt, options.modelResolved, timeoutMs)
        const parsed = parseTier1Json(raw)
        if (!parsed) {
          judge.lastTrace = {
            provider: 'fallback',
            modelRequested: options.modelRequested,
            modelResolved: options.modelResolved,
            latencyMs: Date.now() - started,
            fallbackReason: `${providerId}_cli_parse_error`,
          }
          return failClosedVerdict(`${providerId}_cli_parse_error`)
        }
        judge.lastTrace = {
          provider: traceProvider(options.providerId),
          modelRequested: options.modelRequested,
          modelResolved: options.modelResolved,
          latencyMs: Date.now() - started,
          transport,
          outboundRedacted: true,
        }
        return parsed
      } catch {
        judge.lastTrace = {
          provider: 'fallback',
          modelRequested: options.modelRequested,
          modelResolved: options.modelResolved,
          latencyMs: Date.now() - started,
          fallbackReason: `${providerId}_cli_unavailable`,
        }
        return failClosedVerdict(`${providerId}_cli_unavailable`)
      }
    },
  }
  return judge
}

export function createCodexCliJudge(
  options: Omit<CliJudgeOptions, 'providerId'>,
): TracedTier1Judge {
  return createCliJudge({ ...options, providerId: 'codex' })
}

export function createCursorCliJudge(
  options: Omit<CliJudgeOptions, 'providerId'>,
): TracedTier1Judge {
  return createCliJudge({ ...options, providerId: 'cursor' })
}

export function createClaudeCliJudge(
  options: Omit<CliJudgeOptions, 'providerId'>,
): TracedTier1Judge {
  return createCliJudge({ ...options, providerId: 'claude' })
}
