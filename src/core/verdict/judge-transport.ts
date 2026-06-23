import { hashJudgeSessionRef } from './judge-audit.js'
import { recordJudgeLatency } from './judge-baseline.js'
import { evaluateViaJudgeBroker, invalidateJudgeSession } from './judge-broker-service.js'
import type { JudgeProviderId } from './judge-catalog.js'
import {
  buildCliInvocation,
  CliRunError,
  type CliInvocation,
  type CliJudgeRunCommand,
  parseCliJudgeOutput,
  runCliJsonWithTimeouts,
} from './judge-cli.js'
import { resolveCliVersionFingerprint } from './judge-cli-fingerprint.js'
import { assertReadOnlyInvocationArgs, providerSupportsSession } from './judge-provider-matrix.js'
import type { BelayJudgeRuntimeConfig } from './judge-runtime-config.js'
import { resolveSessionEvalTimeoutMs } from './judge-runtime-config.js'
import type { BrokerEvaluateResult } from './judge-session-broker.js'
import {
  buildJudgeSessionKey,
  exceedsPromptBudget,
  guardFailClosedFallbackReason,
  type JudgeFallbackReason,
  type JudgeSessionResetReason,
} from './judge-session-guard.js'
import {
  isJudgeSessionKillSwitchActive,
  recordShadowComparison,
  shouldRunShadowComparison,
  triggerJudgeSessionKillSwitch,
  verdictsEquivalent,
} from './judge-shadow.js'
import type { Tier1Verdict } from './types.js'

export interface JudgeTransportContext {
  providerId: Exclude<JudgeProviderId, 'ollama'>
  model: string
  repoRoot: string
  stateDir: string
  judgeMode: string
  runtime: BelayJudgeRuntimeConfig
  judgeTimeoutMs: number
}

export interface JudgeTransportEvaluateRequest {
  prompt: string
  context: JudgeTransportContext
}

export interface JudgeTransportEvaluateResult {
  raw: string
  verdict: Tier1Verdict | null
  transport: 'spawn' | 'session'
  sessionUsed: boolean
  sessionReused: boolean
  fallbackReason?: JudgeFallbackReason
  sessionResetReason?: JudgeSessionResetReason
  shadowCompared?: boolean
  shadowMismatch?: boolean
  shadowMismatchRateWindow?: number
  killSwitchTriggered?: boolean
  sessionRefHash?: string
  connectMs: number
  evalMs: number
  parseMs: number
}

export interface JudgeTransportBridgeOptions {
  runCommand?: CliJudgeRunCommand
}

function isEvalTimeoutError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return /timed out/i.test(message)
}

function classifyParseFailure(
  providerId: Exclude<JudgeProviderId, 'ollama'>,
  raw: string,
): JudgeFallbackReason {
  const trimmed = raw.trim()
  if (!trimmed) {
    return 'non_json_response'
  }
  if (parseCliJudgeOutput(providerId, trimmed)) {
    return 'parse_error'
  }
  try {
    JSON.parse(trimmed)
    return 'parse_error'
  } catch {
    return 'non_json_response'
  }
}

function spawnFallbackReason(
  providerId: Exclude<JudgeProviderId, 'ollama'>,
  error: unknown,
): JudgeFallbackReason {
  if (error instanceof CliRunError) {
    if (error.kind === 'timeout') {
      return 'eval_timeout'
    }
    if (error.kind === 'exit_nonzero') {
      return `${providerId}_cli_nonzero`
    }
    if (error.kind === 'spawn_error') {
      return `${providerId}_cli_spawn_error`
    }
  }
  if (isEvalTimeoutError(error)) {
    return 'eval_timeout'
  }
  return `${providerId}_cli_unavailable`
}

function parseWithBudget(
  providerId: Exclude<JudgeProviderId, 'ollama'>,
  raw: string,
): { verdict: Tier1Verdict | null; parseMs: number } {
  const started = Date.now()
  const verdict = parseCliJudgeOutput(providerId, raw)
  const parseMs = Date.now() - started
  recordJudgeLatency('tier1_parse', parseMs)
  return { verdict, parseMs }
}

async function runSpawnTransport(
  request: JudgeTransportEvaluateRequest,
  runCommand: CliJudgeRunCommand,
): Promise<JudgeTransportEvaluateResult> {
  const { context, prompt } = request
  const sessionConfig = context.runtime.session
  const invocation = buildCliInvocation(context.providerId, prompt, context.model)
  const readOnly = assertReadOnlyInvocationArgs(context.providerId, invocation.args)
  if (!readOnly.ok) {
    return {
      raw: '',
      verdict: null,
      transport: 'spawn',
      sessionUsed: false,
      sessionReused: false,
      fallbackReason: 'unsafe_option_rejected',
      connectMs: 0,
      evalMs: 0,
      parseMs: 0,
    }
  }

  const evalTimeoutMs = resolveSessionEvalTimeoutMs(sessionConfig, context.judgeTimeoutMs)
  let raw = ''
  let evalMs = 0
  const evalStarted = Date.now()
  try {
    raw = await runCommand(invocation, evalTimeoutMs)
    evalMs = Date.now() - evalStarted
    recordJudgeLatency('tier1_spawn', evalMs)
  } catch (error) {
    evalMs = Date.now() - evalStarted
    return {
      raw: '',
      verdict: null,
      transport: 'spawn',
      sessionUsed: false,
      sessionReused: false,
      fallbackReason: spawnFallbackReason(context.providerId, error),
      connectMs: 0,
      evalMs,
      parseMs: 0,
    }
  }

  const parsed = parseWithBudget(context.providerId, raw)

  return {
    raw,
    verdict: parsed.verdict,
    transport: 'spawn',
    sessionUsed: false,
    sessionReused: false,
    fallbackReason: parsed.verdict ? undefined : classifyParseFailure(context.providerId, raw),
    connectMs: 0,
    evalMs,
    parseMs: parsed.parseMs,
  }
}

async function runSessionTransport(
  request: JudgeTransportEvaluateRequest,
  runCommand: CliJudgeRunCommand,
): Promise<JudgeTransportEvaluateResult> {
  const { context, prompt } = request
  const sessionConfig = context.runtime.session
  const connectStarted = Date.now()

  if (
    !sessionConfig.enabled ||
    !providerSupportsSession(context.providerId, sessionConfig.providerAllowlist) ||
    (await isJudgeSessionKillSwitchActive(context.repoRoot, context.stateDir))
  ) {
    return runSpawnTransport(request, runCommand)
  }

  let cliVersion = 'unknown'
  try {
    cliVersion = await resolveCliVersionFingerprint(
      context.providerId,
      sessionConfig.connectTimeoutMs,
    )
  } catch {
    return {
      ...(await runSpawnTransport(request, runCommand)),
      fallbackReason: 'connect_timeout',
      sessionUsed: false,
      sessionReused: false,
    }
  }
  const connectMs = Date.now() - connectStarted
  recordJudgeLatency('tier1_connect', connectMs)

  const promptBytes = Buffer.byteLength(prompt, 'utf8')
  if (exceedsPromptBudget(promptBytes, sessionConfig)) {
    const spawnResult = await runSpawnTransport(request, runCommand)
    return {
      ...spawnResult,
      sessionUsed: false,
      sessionReused: false,
      sessionResetReason: 'max_prompt_bytes_exceeded',
      fallbackReason: 'guard_reset',
    }
  }

  const keyParts = {
    providerId: context.providerId,
    model: context.model,
    repoRoot: context.repoRoot,
    judgeMode: context.judgeMode,
    cliVersion,
  }
  const sessionKey = buildJudgeSessionKey(keyParts)
  const sessionRefHash = hashJudgeSessionRef(sessionKey)

  const invocation = buildCliInvocation(context.providerId, prompt, context.model)
  const readOnly = assertReadOnlyInvocationArgs(context.providerId, invocation.args)
  if (!readOnly.ok) {
    return runSpawnTransport(request, runCommand)
  }

  const evalTimeoutMs = resolveSessionEvalTimeoutMs(sessionConfig, context.judgeTimeoutMs)
  const evalStarted = Date.now()
  let brokerResult: BrokerEvaluateResult
  try {
    brokerResult = await evaluateViaJudgeBroker({
      stateDir: context.stateDir,
      repoRoot: context.repoRoot,
      sessionConfig,
      request: {
        keyParts,
        invocation,
        promptBytes,
      },
      timeoutMs: evalTimeoutMs,
      runCommand,
    })
  } catch (error) {
    const spawnResult = await runSpawnTransport(request, runCommand)
    return {
      ...spawnResult,
      transport: 'session',
      sessionUsed: true,
      sessionReused: false,
      fallbackReason: spawnFallbackReason(context.providerId, error),
      sessionResetReason: 'cli_error',
      sessionRefHash,
    }
  }
  const evalMs = Date.now() - evalStarted
  recordJudgeLatency('tier1_session', evalMs)
  recordJudgeLatency('tier1_eval', evalMs)

  const parsed = parseWithBudget(context.providerId, brokerResult.raw)

  if (!parsed.verdict) {
    const parseReason = classifyParseFailure(context.providerId, brokerResult.raw)
    await invalidateJudgeSession({
      stateDir: context.stateDir,
      repoRoot: context.repoRoot,
      sessionConfig,
      sessionKey,
      reason: parseReason === 'non_json_response' ? 'non_json_response' : 'parse_failure',
    })
    const spawnResult = await runSpawnTransport(request, runCommand)
    return {
      ...spawnResult,
      transport: 'session',
      sessionUsed: true,
      sessionReused: brokerResult.reused,
      fallbackReason: guardFailClosedFallbackReason(
        parseReason === 'non_json_response' ? 'non_json_response' : 'parse_failure',
      ),
      sessionResetReason:
        parseReason === 'non_json_response' ? 'non_json_response' : 'parse_failure',
      sessionRefHash,
    }
  }

  return {
    raw: brokerResult.raw,
    verdict: parsed.verdict,
    transport: 'session',
    sessionUsed: true,
    sessionReused: brokerResult.reused,
    sessionResetReason: brokerResult.resetReason,
    sessionRefHash,
    connectMs,
    evalMs,
    parseMs: parsed.parseMs,
  }
}

export async function evaluateWithJudgeTransport(
  request: JudgeTransportEvaluateRequest,
  options: JudgeTransportBridgeOptions = {},
): Promise<JudgeTransportEvaluateResult> {
  const runCommand: CliJudgeRunCommand =
    options.runCommand ??
    ((invocation, timeoutMs) => runCliJsonWithTimeouts(invocation, { evalTimeoutMs: timeoutMs }))
  const { context } = request
  const useSession =
    context.runtime.session.enabled &&
    providerSupportsSession(context.providerId, context.runtime.session.providerAllowlist) &&
    !(await isJudgeSessionKillSwitchActive(context.repoRoot, context.stateDir))

  const primary = useSession
    ? await runSessionTransport(request, runCommand)
    : await runSpawnTransport(request, runCommand)

  if (!shouldRunShadowComparison(context.repoRoot, context.providerId, context.runtime.shadow)) {
    return primary
  }

  const shadowSpawn =
    primary.transport === 'session' ? await runSpawnTransport(request, runCommand) : primary

  if (!primary.verdict || !shadowSpawn.verdict) {
    return primary
  }

  const shadow = recordShadowComparison(
    context.repoRoot,
    context.runtime.shadow,
    !verdictsEquivalent(primary.verdict, shadowSpawn.verdict),
  )

  if (shadow.killSwitchTriggered) {
    await triggerJudgeSessionKillSwitch(context.repoRoot, context.stateDir)
  }

  return {
    ...primary,
    shadowCompared: shadow.compared,
    shadowMismatch: shadow.mismatch,
    shadowMismatchRateWindow: shadow.mismatchRateWindow,
    killSwitchTriggered: shadow.killSwitchTriggered,
    verdict: shadow.mismatch ? shadowSpawn.verdict : primary.verdict,
    fallbackReason: shadow.mismatch ? 'shadow_forced_spawn' : primary.fallbackReason,
    transport: shadow.mismatch ? 'spawn' : primary.transport,
    sessionUsed: shadow.mismatch ? false : primary.sessionUsed,
    sessionReused: shadow.mismatch ? false : primary.sessionReused,
  }
}

export function buildTransportInvocation(
  providerId: Exclude<JudgeProviderId, 'ollama'>,
  prompt: string,
  model: string,
): CliInvocation {
  return buildCliInvocation(providerId, prompt, model)
}
