import { spawn } from 'node:child_process'

import type { ScrubOptions } from '../types.js'
import {
  buildTier1Prompt,
  parseTier1Json,
  prescanInterpreterCode,
  type Tier1JudgeTrace,
  type Tier1JudgeTransport,
  type TracedTier1Judge,
} from './judge.js'
import type { JudgeProviderId } from './judge-catalog.js'
import { scrubOutboundForJudge } from './judge-outbound.js'

export interface CliJudgeOptions {
  providerId: JudgeProviderId
  modelRequested: string
  modelResolved: string
  timeoutMs?: number
  sensitivePaths: string[]
  scrubOptions: ScrubOptions
  runCliCommand?: CliJudgeRunCommand
}

export interface CliInvocation {
  binary: string
  args: string[]
  stdin?: string
}

export type CliJudgeRunCommand = (invocation: CliInvocation, timeoutMs: number) => Promise<string>

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

export function buildCliInvocation(
  providerId: Exclude<JudgeProviderId, 'ollama'>,
  prompt: string,
  model: string,
): CliInvocation {
  if (providerId === 'codex') {
    return {
      binary: CLI_BINARIES[providerId],
      args: [
        'exec',
        '--json',
        '--skip-git-repo-check',
        '--sandbox',
        'read-only',
        '--model',
        model,
        '-',
      ],
      stdin: prompt,
    }
  }

  if (providerId === 'cursor') {
    return {
      binary: CLI_BINARIES[providerId],
      args: [
        '--print',
        '--output-format',
        'json',
        '--mode',
        'ask',
        '--sandbox',
        'enabled',
        '--trust',
        '--model',
        model,
        prompt,
      ],
    }
  }

  return {
    binary: CLI_BINARIES[providerId],
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
      model,
    ],
    stdin: prompt,
  }
}

function tryParseJson(raw: string): unknown | null {
  try {
    return JSON.parse(raw) as unknown
  } catch {
    return null
  }
}

function extractVerdictFromJsonValue(value: unknown): ReturnType<typeof parseTier1Json> {
  if (typeof value === 'string') {
    return parseTier1Json(value.trim())
  }
  if (Array.isArray(value)) {
    for (let index = value.length - 1; index >= 0; index -= 1) {
      const verdict = extractVerdictFromJsonValue(value[index])
      if (verdict) {
        return verdict
      }
    }
    return null
  }
  if (!value || typeof value !== 'object') {
    return null
  }

  const record = value as Record<string, unknown>
  for (const key of ['result', 'content', 'text', 'message', 'output_text', 'final']) {
    if (!(key in record)) {
      continue
    }
    const verdict = extractVerdictFromJsonValue(record[key])
    if (verdict) {
      return verdict
    }
  }

  for (const candidate of Object.values(record).reverse()) {
    const verdict = extractVerdictFromJsonValue(candidate)
    if (verdict) {
      return verdict
    }
  }
  return null
}

function parseCliJsonLines(raw: string): ReturnType<typeof parseTier1Json> {
  const lines = raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)

  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const parsed = tryParseJson(lines[index] ?? '')
    if (!parsed) {
      continue
    }
    const verdict = extractVerdictFromJsonValue(parsed)
    if (verdict) {
      return verdict
    }
  }
  return null
}

export function parseCliJudgeOutput(
  providerId: Exclude<JudgeProviderId, 'ollama'>,
  raw: string,
): ReturnType<typeof parseTier1Json> {
  const direct = parseTier1Json(raw)
  if (direct) {
    return direct
  }

  const parsed = tryParseJson(raw)
  if (parsed) {
    const envelopeVerdict = extractVerdictFromJsonValue(parsed)
    if (envelopeVerdict) {
      return envelopeVerdict
    }
  }

  if (providerId === 'codex') {
    return parseCliJsonLines(raw)
  }

  return parseCliJsonLines(raw)
}

async function runCliJson(invocation: CliInvocation, timeoutMs: number): Promise<string> {
  const { binary, args, stdin } = invocation
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
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
    if (stdin !== undefined) {
      child.stdin.write(stdin)
    }
    child.stdin.end()
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
  const runCommand = options.runCliCommand ?? runCliJson

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
        const raw = await runCommand(
          buildCliInvocation(providerId, prompt, options.modelResolved),
          timeoutMs,
        )
        const parsed = parseCliJudgeOutput(providerId, raw)
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
