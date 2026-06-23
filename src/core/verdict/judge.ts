import { matchesSensitivePath } from '../glob.js'
import { resolveMutationTarget, resolveWorkspaceRootMatch } from '../path-utils.js'
import type { ScrubOptions } from '../types.js'
import { resolveTrustedPath } from './containment.js'
import { scrubOutboundForJudge } from './judge-outbound.js'
import { isOutsideRepoSecretCredentialPath, isPersistentAgentPath } from './persistent-paths.js'
import type { Tier1Judge, Tier1Verdict } from './types.js'

const SECRET_PATTERNS = [/\.env\b/i, /\.pem\b/i, /id_rsa\b/i, /credentials/i, /secrets?\b/i]
const DESTRUCTIVE_VERBS = /\b(rm|rmtree|unlink|delete|truncate|shred|destroy|drop)\b/i
const GIT_PATTERNS = /\.git\b/i

const TIER1_PROMPT = `Answer ONLY with JSON: {"local_recoverable":boolean,"destroys_history_or_secrets":boolean,"reason":string}
reason should be a short snake_case label.

local_recoverable: true if a mistaken operation can be undone locally (git revert, fs snapshot, trivial manual revert).
local_recoverable: false if remote/destructive (git push --force, aws s3 rm, secret send) OR persistent local harm (~/.ssh/authorized_keys, shell rc, crontab, ~/.config persistence).

destroys_history_or_secrets: true if the operation deletes or corrupts git history (.git), overwrites secrets/credentials, or modifies persistent agent startup (shell rc, crontab, launchd, authorized_keys).

Examples local_recoverable=true, destroys_history_or_secrets=false: IDE plan files under the user home, /tmp files, in-repo edits, READ/QUERY/GET.
Examples local_recoverable=false OR destroys_history_or_secrets=true: remote mutations, credential paths, agent startup persistence, rm -rf .git.
If genuinely ambiguous about recoverability or persistent harm, answer false.

Command/code:
`

export type Tier1JudgeTransport =
  | 'http'
  | 'ollama-http'
  | 'codex-cli'
  | 'cursor-cli'
  | 'claude-cli'
  | 'codex-cli-session'
  | 'cursor-cli-session'
  | 'claude-cli-session'
  | 'unavailable'

export interface Tier1JudgeTrace {
  provider: 'openai-compatible' | 'ollama' | 'anthropic' | 'fallback'
  modelRequested: string
  modelResolved: string
  latencyMs: number
  transport?: Tier1JudgeTransport
  outboundRedacted?: boolean
  fallbackReason?: string
  judgeSessionUsed?: boolean
  judgeSessionReused?: boolean
  judgeSessionRefHash?: string
  judgeSessionResetReason?: string
  judgeFallbackReason?: string
  judgeConnectMs?: number
  judgeEvalMs?: number
  judgeParseMs?: number
  judgeShadowCompared?: boolean
  judgeShadowMismatch?: boolean
  judgeShadowMismatchRateWindow?: number
  judgeKillSwitchTriggered?: boolean
}

export interface TracedTier1Judge extends Tier1Judge {
  lastTrace?: Tier1JudgeTrace
}

function failClosedVerdict(reason: string): Tier1Verdict {
  return {
    local_recoverable: false,
    destroys_outside_repo: true,
    destroys_history_or_secrets: true,
    external_change: true,
    reason,
  }
}

function parseLocalRecoverable(parsed: Partial<Tier1Verdict>): boolean | null {
  if (typeof parsed.local_recoverable === 'boolean') {
    return parsed.local_recoverable
  }
  if (typeof parsed.external_change === 'boolean') {
    return !parsed.external_change
  }
  return null
}

export function buildTier1Prompt(text: string): string {
  return `${TIER1_PROMPT}${text}`
}

export function parseTier1Json(raw: string): Tier1Verdict | null {
  try {
    const parsed = JSON.parse(raw) as Partial<Tier1Verdict>
    const localRecoverable = parseLocalRecoverable(parsed)
    if (localRecoverable === null) {
      return null
    }
    return {
      local_recoverable: localRecoverable,
      destroys_outside_repo:
        typeof parsed.destroys_outside_repo === 'boolean' ? parsed.destroys_outside_repo : false,
      destroys_history_or_secrets:
        typeof parsed.destroys_history_or_secrets === 'boolean'
          ? parsed.destroys_history_or_secrets
          : false,
      external_change: parsed.external_change,
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
      local_recoverable: true,
      destroys_outside_repo: false,
      destroys_history_or_secrets: true,
      reason: 'prescan_destructive_secret',
    }
  }
  return null
}

export interface MutationPrescanParams {
  targets: string[]
  cwd: string
  repoRoot: string
  trustedCwd: boolean
  trustedWorkspaceRoots?: string[]
  sensitivePaths: string[]
}

/** ADR-002 M3: structural prescan for sensitive / persistent mutation targets (shell redirects, etc.). */
export function prescanMutationTargets(params: MutationPrescanParams): Tier1Verdict | null {
  for (const target of params.targets) {
    const resolved =
      resolveTrustedPath(target, params.cwd, params.trustedCwd) ??
      resolveMutationTarget(target, params.cwd)
    if (!resolved) {
      continue
    }
    const workspaceMatch = resolveWorkspaceRootMatch(
      params.repoRoot,
      params.trustedWorkspaceRoots,
      resolved,
    )
    if (
      workspaceMatch !== null &&
      matchesSensitivePath(workspaceMatch.relativePath.replaceAll('\\', '/'), params.sensitivePaths)
    ) {
      return {
        local_recoverable: false,
        destroys_outside_repo: false,
        destroys_history_or_secrets: true,
        reason: 'sensitive_path_mutation',
      }
    }
    if (
      (workspaceMatch === null || workspaceMatch.kind === 'trusted') &&
      isOutsideRepoSecretCredentialPath(resolved)
    ) {
      return {
        local_recoverable: false,
        destroys_outside_repo: false,
        destroys_history_or_secrets: true,
        reason: 'outside_repo_secret_credential_path',
      }
    }
    if (isPersistentAgentPath(resolved)) {
      return {
        local_recoverable: false,
        destroys_outside_repo: false,
        destroys_history_or_secrets: true,
        reason: 'persistent_agent_path',
      }
    }
  }
  return null
}

/** Returns prescan verdict when structural M3 rules require ask (before Tier1 LLM). */
export function mutationPrescanRequiresAsk(params: MutationPrescanParams): Tier1Verdict | null {
  const prescan = prescanMutationTargets(params)
  return prescan && tier1RequiresAsk(prescan) ? prescan : null
}

/** Conservative stub: Tier1 defers to Tier0; returns safe negatives for structural suite. */
export function createDeterministicJudgeStub(): TracedTier1Judge {
  return {
    evaluate() {
      return Promise.resolve({
        local_recoverable: true,
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
  return !verdict.local_recoverable || verdict.destroys_history_or_secrets
}
