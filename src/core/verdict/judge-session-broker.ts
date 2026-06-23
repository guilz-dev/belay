import type { JudgeProviderId } from './judge-catalog.js'
import type { CliInvocation, CliJudgeRunCommand } from './judge-cli.js'
import type { BelayJudgeSessionConfig } from './judge-runtime-config.js'
import {
  buildJudgeSessionKey,
  evaluateSessionReuse,
  type JudgeSessionBudget,
  type JudgeSessionKeyParts,
  type JudgeSessionResetReason,
} from './judge-session-guard.js'
import { MutexRegistry } from './judge-session-mutex.js'

export type BrokerSessionState = 'idle' | 'busy'

export interface BrokerSessionRecord {
  keyParts: JudgeSessionKeyParts
  budget: JudgeSessionBudget
  state: BrokerSessionState
  providerResumeId?: string
  lastResetReason?: JudgeSessionResetReason
}

export interface BrokerEvaluateRequest {
  keyParts: JudgeSessionKeyParts
  invocation: CliInvocation
  promptBytes: number
}

export interface BrokerEvaluateResult {
  raw: string
  reused: boolean
  resetReason?: JudgeSessionResetReason
  providerResumeId?: string
}

type RunCommand = CliJudgeRunCommand

export interface JudgeSessionBrokerOptions {
  config: BelayJudgeSessionConfig
  runCommand: RunCommand
  extractResumeId?: (providerId: Exclude<JudgeProviderId, 'ollama'>, raw: string) => string | null
}

export class JudgeSessionBroker {
  private readonly sessions = new Map<string, BrokerSessionRecord>()
  private readonly mutexes = new MutexRegistry()
  private readonly options: JudgeSessionBrokerOptions

  constructor(options: JudgeSessionBrokerOptions) {
    this.options = options
  }

  listSessions(): BrokerSessionRecord[] {
    return [...this.sessions.values()]
  }

  invalidateSession(sessionKey: string, reason: JudgeSessionResetReason): void {
    const session = this.sessions.get(sessionKey)
    if (session) {
      session.lastResetReason = reason
      session.state = 'idle'
    }
    this.sessions.delete(sessionKey)
  }

  stopAll(reason: JudgeSessionResetReason = 'manual_stop'): number {
    const count = this.sessions.size
    for (const session of this.sessions.values()) {
      session.lastResetReason = reason
      session.state = 'idle'
    }
    this.sessions.clear()
    this.mutexes.clear()
    return count
  }

  async evaluate(request: BrokerEvaluateRequest, timeoutMs: number): Promise<BrokerEvaluateResult> {
    const sessionKey = buildJudgeSessionKey(request.keyParts)
    return this.mutexes.forKey(sessionKey).run(() => this.evaluateExclusive(request, timeoutMs))
  }

  private async evaluateExclusive(
    request: BrokerEvaluateRequest,
    timeoutMs: number,
  ): Promise<BrokerEvaluateResult> {
    const sessionKey = buildJudgeSessionKey(request.keyParts)
    const providerId = request.keyParts.providerId as Exclude<JudgeProviderId, 'ollama'>
    const existing = this.sessions.get(sessionKey)
    const reuseDecision = evaluateSessionReuse(
      existing?.keyParts ?? null,
      request.keyParts,
      existing?.budget ?? null,
      this.options.config,
      Date.now(),
      request.promptBytes,
    )
    const resetReason = reuseDecision.canReuse ? undefined : reuseDecision.resetReason
    let session = existing

    if (!reuseDecision.canReuse || !session) {
      session = {
        keyParts: request.keyParts,
        budget: {
          turnCount: 0,
          createdAtMs: Date.now(),
          lastUsedAtMs: Date.now(),
          promptBytes: 0,
        },
        state: 'busy',
        lastResetReason: resetReason ?? 'initial',
      }
      this.enforceProviderSessionCap(providerId, sessionKey)
      this.sessions.set(sessionKey, session)
    } else {
      session.state = 'busy'
      session.budget.lastUsedAtMs = Date.now()
    }

    const invocation =
      reuseDecision.canReuse && session.providerResumeId
        ? this.buildResumeInvocation(request.invocation, providerId, session.providerResumeId)
        : request.invocation
    const resumed = reuseDecision.canReuse && Boolean(session.providerResumeId)

    try {
      const raw = await this.options.runCommand(invocation, timeoutMs)
      session.budget.turnCount += 1
      session.budget.promptBytes += request.promptBytes
      session.budget.lastUsedAtMs = Date.now()
      session.state = 'idle'

      const extracted =
        this.options.extractResumeId?.(providerId, raw) ??
        extractProviderResumeId(providerId, raw) ??
        undefined
      if (extracted) {
        session.providerResumeId = extracted
      }

      return {
        raw,
        reused: resumed,
        resetReason: session.lastResetReason,
        providerResumeId: session.providerResumeId,
      }
    } catch (error) {
      session.state = 'idle'
      session.lastResetReason = 'cli_error'
      this.sessions.delete(sessionKey)
      throw error
    }
  }

  private enforceProviderSessionCap(
    providerId: Exclude<JudgeProviderId, 'ollama'>,
    keepKey: string,
  ): void {
    const cap = this.options.config.maxSessionsPerProvider
    const sameProvider = [...this.sessions.entries()].filter(
      ([, record]) => record.keyParts.providerId === providerId,
    )
    if (sameProvider.length < cap) {
      return
    }
    for (const [key] of sameProvider) {
      if (key === keepKey) {
        continue
      }
      this.sessions.delete(key)
      if (this.sessions.size < cap) {
        break
      }
    }
  }

  private buildResumeInvocation(
    base: CliInvocation,
    providerId: Exclude<JudgeProviderId, 'ollama'>,
    resumeId: string,
  ): CliInvocation {
    if (providerId === 'cursor') {
      const args = [...base.args]
      const modelIndex = args.indexOf('--model')
      const model = modelIndex >= 0 ? args[modelIndex + 1] : undefined
      const prompt = args[args.length - 1]
      return {
        binary: base.binary,
        args: [
          '--print',
          '--output-format',
          'json',
          '--mode',
          'ask',
          '--sandbox',
          'enabled',
          '--trust',
          '--resume',
          resumeId,
          ...(model ? ['--model', model] : []),
          prompt,
        ],
      }
    }

    if (providerId === 'claude') {
      return {
        ...base,
        args: [...base.args, '--continue', resumeId],
      }
    }

    return base
  }
}

export function extractProviderResumeId(
  providerId: Exclude<JudgeProviderId, 'ollama'>,
  raw: string,
): string | null {
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>
    const candidates = [
      parsed.chat_id,
      parsed.chatId,
      parsed.session_id,
      parsed.sessionId,
      (parsed.result as Record<string, unknown> | undefined)?.chat_id,
      (parsed.result as Record<string, unknown> | undefined)?.session_id,
    ]
    for (const candidate of candidates) {
      if (typeof candidate === 'string' && candidate.trim()) {
        return candidate.trim()
      }
    }
  } catch {
    // fall through
  }

  if (providerId === 'cursor') {
    const match = raw.match(/"chat_id"\s*:\s*"([^"]+)"/)
    if (match?.[1]) {
      return match[1]
    }
  }

  return null
}

const repoBrokers = new Map<string, JudgeSessionBroker>()

export function getRepoJudgeSessionBroker(
  repoRoot: string,
  options: JudgeSessionBrokerOptions,
): JudgeSessionBroker {
  const existing = repoBrokers.get(repoRoot)
  if (existing) {
    return existing
  }
  const broker = new JudgeSessionBroker(options)
  repoBrokers.set(repoRoot, broker)
  return broker
}

export function stopRepoJudgeSessionBroker(
  repoRoot: string,
  reason: JudgeSessionResetReason = 'manual_stop',
): number {
  const broker = repoBrokers.get(repoRoot)
  if (!broker) {
    return 0
  }
  const count = broker.stopAll(reason)
  repoBrokers.delete(repoRoot)
  return count
}

export function resetJudgeSessionBrokersForTests(): void {
  for (const broker of repoBrokers.values()) {
    broker.stopAll('manual_stop')
  }
  repoBrokers.clear()
}

export function listRepoJudgeSessionBrokers(): string[] {
  return [...repoBrokers.keys()]
}
