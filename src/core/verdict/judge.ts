import type { ScrubOptions } from '../types.js'
import { scrubOutboundForJudge } from './judge-outbound.js'
import type { Tier1Judge, Tier1Verdict } from './types.js'

const SECRET_PATTERNS = [/\.env\b/i, /\.pem\b/i, /id_rsa\b/i, /credentials/i, /secrets?\b/i]
const DESTRUCTIVE_VERBS = /\b(rm|rmtree|unlink|delete|truncate|shred|destroy|drop)\b/i
const GIT_PATTERNS = /\.git\b/i

const TIER1_PROMPT = `Answer ONLY with JSON: {"external_change":boolean,"reason":string}
reason should be a short snake_case label.

external_change: true if this operation CREATEs, MODIFYs, DELETEs, or SENDs data to any system outside the local machine and its git repository working tree.
READ/QUERY/GET/list/describe/SELECT/HTTP GET is NOT a change. Local build, test, and package install inside the repo are NOT external changes.
If unsure, answer true.

Command/code:
`

export interface Tier1JudgeTrace {
  provider: 'openai-compatible' | 'ollama' | 'fallback'
  modelRequested: string
  modelResolved: string
  latencyMs: number
  outboundRedacted?: boolean
  fallbackReason?: string
}

export interface TracedTier1Judge extends Tier1Judge {
  lastTrace?: Tier1JudgeTrace
}

function failClosedVerdict(reason: string): Tier1Verdict {
  return {
    external_change: true,
    destroys_outside_repo: true,
    destroys_history_or_secrets: true,
    reason,
  }
}

function parseTier1Json(raw: string): Tier1Verdict | null {
  try {
    const parsed = JSON.parse(raw) as Partial<Tier1Verdict>
    if (typeof parsed.external_change !== 'boolean') {
      return null
    }
    return {
      external_change: parsed.external_change,
      destroys_outside_repo: false,
      destroys_history_or_secrets: false,
      reason: typeof parsed.reason === 'string' ? parsed.reason : 'tier1_llm',
    }
  } catch {
    return null
  }
}

export function prescanInterpreterCode(code: string): Tier1Verdict | null {
  const normalized = code.replaceAll('\\', '/')
  const hitsSecret = SECRET_PATTERNS.some((pattern) => pattern.test(normalized))
  const hitsGit = GIT_PATTERNS.test(normalized)
  const hitsDestructive = DESTRUCTIVE_VERBS.test(normalized)
  if ((hitsSecret || hitsGit) && hitsDestructive) {
    return {
      external_change: false,
      destroys_outside_repo: false,
      destroys_history_or_secrets: true,
      reason: 'prescan_destructive_secret',
    }
  }
  return null
}

/** Conservative stub: Tier1 defers to Tier0; returns safe negatives for structural suite. */
export function createDeterministicJudgeStub(): TracedTier1Judge {
  return {
    evaluate() {
      return Promise.resolve({
        external_change: false,
        destroys_outside_repo: false,
        destroys_history_or_secrets: false,
        reason: 'deterministic_stub',
      })
    },
  }
}

/** Fail-closed judge for when Tier1 is required but unavailable. */
export function createFailClosedJudge(options?: {
  reason?: string
  fallbackReason?: string
  modelRequested?: string
  modelResolved?: string
}): TracedTier1Judge {
  const reason = options?.reason ?? 'fail_closed'
  const judge: TracedTier1Judge = {
    evaluate() {
      const started = Date.now()
      if (options?.fallbackReason) {
        judge.lastTrace = {
          provider: 'fallback',
          modelRequested: options.modelRequested ?? 'unknown',
          modelResolved: options.modelResolved ?? 'unknown',
          latencyMs: Date.now() - started,
          fallbackReason: options.fallbackReason,
        }
      }
      return Promise.resolve(failClosedVerdict(reason))
    },
  }
  return judge
}

export interface OllamaJudgeOptions {
  model?: string
  baseUrl?: string
  timeoutMs?: number
  keepAlive?: string | null
  fetchImpl?: typeof fetch
}

export function createOllamaJudge(options: OllamaJudgeOptions = {}): TracedTier1Judge {
  const model = options.model ?? 'gemma4:e2b'
  const baseUrl = (options.baseUrl ?? 'http://127.0.0.1:11434').replace(/\/$/, '')
  const timeoutMs = options.timeoutMs ?? 25000
  const fetchImpl = options.fetchImpl ?? fetch

  const judge: TracedTier1Judge = {
    async evaluate(input) {
      const started = Date.now()
      const prescan = input.innerCode ? prescanInterpreterCode(input.innerCode) : null
      if (prescan?.destroys_history_or_secrets) {
        judge.lastTrace = {
          provider: 'ollama',
          modelRequested: model,
          modelResolved: model,
          latencyMs: Date.now() - started,
        }
        return prescan
      }

      const body = `${TIER1_PROMPT}${input.text}`
      try {
        const response = await fetchImpl(`${baseUrl}/api/generate`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            model,
            prompt: body,
            stream: false,
            format: 'json',
            keep_alive: options.keepAlive ?? undefined,
          }),
          signal: AbortSignal.timeout(timeoutMs),
        })
        if (!response.ok) {
          judge.lastTrace = {
            provider: 'fallback',
            modelRequested: model,
            modelResolved: model,
            latencyMs: Date.now() - started,
            fallbackReason: `ollama_http_${response.status}`,
          }
          return failClosedVerdict('ollama_unavailable')
        }
        const payload = (await response.json()) as { response?: string }
        const parsed = parseTier1Json(payload.response ?? '{}')
        if (!parsed) {
          judge.lastTrace = {
            provider: 'fallback',
            modelRequested: model,
            modelResolved: model,
            latencyMs: Date.now() - started,
            fallbackReason: 'ollama_parse_error',
          }
          return failClosedVerdict('ollama_parse_error')
        }
        judge.lastTrace = {
          provider: 'ollama',
          modelRequested: model,
          modelResolved: model,
          latencyMs: Date.now() - started,
        }
        return parsed
      } catch (error) {
        judge.lastTrace = {
          provider: 'fallback',
          modelRequested: model,
          modelResolved: model,
          latencyMs: Date.now() - started,
          fallbackReason: error instanceof Error ? error.message : 'ollama_error',
        }
        return failClosedVerdict('ollama_unavailable')
      }
    },
  }
  return judge
}

export interface OpenAiCompatibleJudgeOptions {
  endpoint: string
  modelRequested: string
  modelResolved: string
  timeoutMs: number
  apiKey?: string
  resolveApiKey?: () => Promise<{ key: string | null; source: string | null }>
  sensitivePaths: string[]
  scrubOptions: ScrubOptions
  fetchImpl?: typeof fetch
}

export function createOpenAiCompatibleJudge(
  options: OpenAiCompatibleJudgeOptions,
): TracedTier1Judge {
  const fetchImpl = options.fetchImpl ?? fetch
  const apiBase = options.endpoint.replace(/\/$/, '')

  const judge: TracedTier1Judge = {
    async evaluate(input) {
      const started = Date.now()
      const prescan = input.innerCode ? prescanInterpreterCode(input.innerCode) : null
      if (prescan?.destroys_history_or_secrets) {
        judge.lastTrace = {
          provider: 'openai-compatible',
          modelRequested: options.modelRequested,
          modelResolved: options.modelResolved,
          latencyMs: Date.now() - started,
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

      const resolvedKey = options.resolveApiKey
        ? await options.resolveApiKey()
        : { key: options.apiKey ?? null, source: null }
      const apiKey = options.apiKey ?? resolvedKey.key
      if (!apiKey) {
        judge.lastTrace = {
          provider: 'fallback',
          modelRequested: options.modelRequested,
          modelResolved: options.modelResolved,
          latencyMs: Date.now() - started,
          fallbackReason: 'missing_api_key',
        }
        return failClosedVerdict('openai_compatible_auth_error')
      }

      const prompt = `${TIER1_PROMPT}${scrubbed.text}`
      try {
        const response = await fetchImpl(`${apiBase}/chat/completions`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify({
            model: options.modelResolved,
            messages: [{ role: 'user', content: prompt }],
            response_format: { type: 'json_object' },
          }),
          signal: AbortSignal.timeout(options.timeoutMs),
        })
        if (!response.ok) {
          judge.lastTrace = {
            provider: 'fallback',
            modelRequested: options.modelRequested,
            modelResolved: options.modelResolved,
            latencyMs: Date.now() - started,
            fallbackReason: `openai_compatible_http_${response.status}`,
          }
          return failClosedVerdict('openai_compatible_unavailable')
        }
        const payload = (await response.json()) as {
          choices?: Array<{ message?: { content?: string } }>
        }
        const content = payload.choices?.[0]?.message?.content ?? '{}'
        const parsed = parseTier1Json(content)
        judge.lastTrace = {
          provider: parsed ? 'openai-compatible' : 'fallback',
          modelRequested: options.modelRequested,
          modelResolved: options.modelResolved,
          latencyMs: Date.now() - started,
          outboundRedacted: true,
          fallbackReason: parsed ? undefined : 'openai_compatible_parse_error',
        }
        return parsed ?? failClosedVerdict('openai_compatible_parse_error')
      } catch (error) {
        judge.lastTrace = {
          provider: 'fallback',
          modelRequested: options.modelRequested,
          modelResolved: options.modelResolved,
          latencyMs: Date.now() - started,
          fallbackReason: error instanceof Error ? error.message : 'openai_compatible_error',
        }
        return failClosedVerdict('openai_compatible_unavailable')
      }
    },
  }
  return judge
}

/** @deprecated Use createOpenAiCompatibleJudge */
export const createCursorJudge = createOpenAiCompatibleJudge

export interface CursorJudgeOptions extends OpenAiCompatibleJudgeOptions {}

export function tier1RequiresAsk(verdict: Tier1Verdict): boolean {
  return verdict.external_change || verdict.destroys_history_or_secrets
}
