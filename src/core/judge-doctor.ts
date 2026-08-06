import { repoLocalStateDirFor } from '../config-io.js'
import type { BelayConfigV4 } from './config.js'
import { normalizeJudgeProvider, scrubOptionsFromConfig } from './config.js'
import { resolveJudgeCredential } from './judge-api-key.js'
import { hasValidCloudConsent } from './judge-config.js'
import {
  formatJudgeRecoveryHint,
  inferProviderIdFromFallbackReason,
} from './judge-fallback-hints.js'
import {
  type CheckJudgeModelPresenceResult,
  discoverJudgeModels,
  type JudgeModelDiscoveryDeps,
  modelPresenceFromDiscovery,
} from './judge-model-discovery.js'
import { detectJudgeRuntimeCapabilities, resolveJudgeTransport } from './judge-runtime-detection.js'
import { createOllamaJudge, createOpenAiCompatibleJudge } from './verdict/judge.js'
import { stopJudgeBrokerDaemon } from './verdict/judge-broker-service.js'
import {
  getJudgeProviderCapabilities,
  getJudgeProviderSpec,
  isRemovedProviderId,
  normalizeLegacyProviderId,
} from './verdict/judge-catalog.js'
import { createJudgeFromConfig, resolveJudgeModel } from './verdict/judge-factory.js'
import { resolveJudgeSmokeProbeTimeoutMs } from './verdict/judge-runtime-config.js'
import {
  listRepoJudgeSessionBrokers,
  stopRepoJudgeSessionBroker,
} from './verdict/judge-session-broker.js'
import { clearJudgeSessionKillSwitch } from './verdict/judge-session-kill-switch.js'

export interface JudgeDoctorResult {
  issues: string[]
  warnings: string[]
  notes: string[]
  modelCheck?: CheckJudgeModelPresenceResult
}

export interface DiagnoseJudgeOptions {
  discoveryDeps?: JudgeModelDiscoveryDeps
  liveProbe?: boolean
}

function judgeShadowAdvisory(warnings: string[], message: string): void {
  warnings.push(`[judge shadow advisory] ${message}`)
}

export async function diagnoseJudge(
  config: BelayConfigV4,
  repoRoot: string = process.cwd(),
  options: DiagnoseJudgeOptions = {},
): Promise<JudgeDoctorResult> {
  const shouldRunLiveProbe =
    options.liveProbe === true && !process.env.VITEST && !process.env.VITEST_WORKER_ID

  const issues: string[] = []
  const warnings: string[] = []
  const notes: string[] = []
  const judge = config.judge
  const gateMode = judge.mode ?? 'shadow'
  notes.push(
    `Judge gate mode: ${gateMode} (sync Tier1 removed from hook gate; judge is shadow/async only)`,
  )
  if (gateMode === 'off') {
    notes.push('Judge shadow is disabled (judge.mode=off).')
  }

  const provider = normalizeJudgeProvider(judge.provider)
  const rawProviderId = judge.providerId ? String(judge.providerId) : undefined

  if (rawProviderId && isRemovedProviderId(rawProviderId)) {
    notes.push(`Judge providerId: ${rawProviderId}`)
    notes.push(`Judge driver: ${provider}`)
    notes.push(`Judge model requested: ${judge.model}`)
    issues.push(
      `judge.providerId "${rawProviderId}" was removed; run belay config set judge.providerId <ollama|codex|claude|cursor> to migrate.`,
    )
    return { issues, warnings, notes }
  }

  const providerId =
    judge.providerId && normalizeLegacyProviderId(judge.providerId)
      ? normalizeLegacyProviderId(judge.providerId)!
      : provider === 'ollama'
        ? 'ollama'
        : provider === 'anthropic'
          ? 'claude'
          : 'codex'
  const catalogSpec = getJudgeProviderSpec(providerId)
  const capabilities = getJudgeProviderCapabilities(providerId)
  const transport = resolveJudgeTransport(judge)
  const runtime = detectJudgeRuntimeCapabilities(providerId)
  const cursorAcpEnabled =
    transport === 'cursor-cli' &&
    providerId === 'cursor' &&
    config.judge.runtime?.session.enabled === true
  const effectiveTransport = cursorAcpEnabled ? 'cursor-acp' : transport

  notes.push(`Judge providerId: ${providerId}`)
  notes.push(`Judge driver: ${provider}`)
  notes.push(`Judge model requested: ${judge.model}`)
  notes.push(`Judge transport: ${effectiveTransport}`)

  if (config.policy.modelAssist.enabled) {
    warnings.push(
      'policy.modelAssist is enabled but is not wired to v2 Tier1. Use top-level judge instead.',
    )
  }

  if (capabilities?.requiresConsent && !hasValidCloudConsent(judge) && transport === 'http') {
    judgeShadowAdvisory(
      warnings,
      'Cloud judge consent is not recorded. Shadow cloud judge will fail until consent is granted.',
    )
  } else if (judge.cloudConsent?.accepted) {
    notes.push(`Cloud consent: accepted ${judge.cloudConsent.at} by ${judge.cloudConsent.by}`)
  }

  if (providerId !== 'ollama') {
    warnings.push(
      'Cloud judge egress is enabled. Commands are redacted (R23) before send, but path structure and intent may still leave the repo.',
    )
  }

  const repoLocalDir = repoLocalStateDirFor(repoRoot, config)
  const keyInfo = await resolveJudgeCredential({
    judge,
    catalogSpec: catalogSpec ?? undefined,
    repoRoot,
    repoLocalStateDir: repoLocalDir,
    config,
  })
  notes.push(`Credential: ${keyInfo.mode} (${keyInfo.sourceKind})`)

  const resolved = resolveJudgeModel(judge)
  notes.push(`Resolved model: ${resolved.resolved}`)

  const endpoint = judge.endpoint ?? (providerId === 'ollama' ? 'http://127.0.0.1:11434' : null)
  const discovery = await discoverJudgeModels(
    {
      providerId,
      model: judge.model,
      endpoint,
    },
    options.discoveryDeps,
  )
  const modelCheck = modelPresenceFromDiscovery(discovery, judge.model)
  notes.push(`Model check: ${modelCheck.status} (source: ${modelCheck.source})`)

  if (providerId === 'ollama') {
    notes.push(`Ollama endpoint: ${endpoint}`)
    if (discovery.modelIds.length === 0) {
      judgeShadowAdvisory(
        warnings,
        'Ollama endpoint unreachable or returned no models. Shadow judge will not run.',
      )
    } else {
      const hasModel = modelCheck.status === 'found'
      if (!hasModel) {
        judgeShadowAdvisory(
          warnings,
          `Ollama model "${judge.model}" is not present. Pull it before enabling shadow comparisons.`,
        )
      } else {
        notes.push(`Ollama model "${judge.model}" is available.`)
      }
    }

    const warm = createOllamaJudge({
      model: judge.model,
      baseUrl: endpoint ?? 'http://127.0.0.1:11434',
      timeoutMs: Math.min(judge.timeoutMs, 5000),
      fetchImpl: async () =>
        new Response(
          JSON.stringify({
            response: JSON.stringify({
              local_recoverable: true,
              destroys_outside_repo: false,
              destroys_history_or_secrets: false,
              reason: 'doctor_warm',
            }),
          }),
          { status: 200 },
        ),
    })
    const warmResult = await warm.evaluate({
      text: 'git status',
      context: { cwd: process.cwd(), repoRoot: process.cwd() },
    })
    if (warmResult.reason === 'ollama_unavailable' || warmResult.reason === 'ollama_parse_error') {
      judgeShadowAdvisory(warnings, `Ollama warm call failed: ${warmResult.reason}`)
    } else {
      notes.push('Ollama warm call succeeded.')
    }
    return { issues, warnings, notes, modelCheck }
  }

  if (transport === 'unavailable') {
    judgeShadowAdvisory(
      warnings,
      'No judge transport is available (configure endpoint or install native CLI). Shadow judge will not run.',
    )
    return { issues, warnings, notes, modelCheck }
  }

  if (transport.endsWith('-cli')) {
    if (!runtime.cliTransport) {
      judgeShadowAdvisory(
        warnings,
        `Native CLI transport (${transport}) is not available. Shadow judge will not run.`,
      )
    } else if (!keyInfo.key && keyInfo.sourceKind !== 'host-session') {
      judgeShadowAdvisory(
        warnings,
        'Judge API key is not set for the configured credential mode. Shadow cloud judge will not run.',
      )
    } else {
      notes.push(
        cursorAcpEnabled
          ? 'Cursor ACP transport available.'
          : `Native CLI transport available: ${transport}`,
      )
      if (cursorAcpEnabled) {
        notes.push(
          `Cursor ACP session transport enabled (max ${config.judge.runtime?.session.maxTurns ?? 'unknown'} turns).`,
        )
      }
      if (shouldRunLiveProbe) {
        const smokeConfig: BelayConfigV4 = {
          ...config,
          judge: {
            ...judge,
            timeoutMs: resolveJudgeSmokeProbeTimeoutMs(judge.timeoutMs),
          },
        }
        const smokeJudge = createJudgeFromConfig(smokeConfig, { repoRoot })
        const smokeResult = await smokeJudge.evaluate({
          text: 'git status',
          context: { cwd: repoRoot, repoRoot },
        })
        const smokeFallback =
          smokeJudge.lastTrace?.judgeFallbackReason ??
          smokeJudge.lastTrace?.fallbackReason ??
          smokeResult.reason
        if (smokeJudge.lastTrace?.provider === 'fallback') {
          const recoveryHint = formatJudgeRecoveryHint(
            inferProviderIdFromFallbackReason(smokeFallback, providerId),
            smokeFallback,
          )
          const smokeLabel = cursorAcpEnabled ? 'Cursor ACP' : 'Native CLI transport'
          judgeShadowAdvisory(
            warnings,
            recoveryHint
              ? `${smokeLabel} smoke probe failed (${smokeFallback}). ${recoveryHint}`
              : `${smokeLabel} smoke probe failed (${smokeFallback}).`,
          )
        } else {
          notes.push(
            cursorAcpEnabled
              ? 'Cursor ACP smoke probe succeeded.'
              : 'Native CLI transport smoke probe succeeded.',
          )
        }
      }
    }
    return { issues, warnings, notes, modelCheck }
  }

  if (judge.endpoint?.trim()) {
    notes.push(`HTTP endpoint: ${judge.endpoint}`)
  }

  if (!keyInfo.key) {
    judgeShadowAdvisory(
      warnings,
      'Judge API key is not set for the configured credential mode. Shadow cloud judge will not run.',
    )
  } else {
    notes.push(`Credential source: ${keyInfo.source ?? keyInfo.sourceKind}`)
  }

  if (keyInfo.key && judge.endpoint?.trim() && hasValidCloudConsent(judge)) {
    const traced = createOpenAiCompatibleJudge({
      endpoint: judge.endpoint.trim(),
      modelRequested: judge.model,
      modelResolved: resolved.resolved,
      timeoutMs: Math.min(judge.timeoutMs, 5000),
      apiKey: keyInfo.key,
      sensitivePaths: config.classifier.sensitivePaths,
      scrubOptions: scrubOptionsFromConfig(config),
      fetchImpl: async () =>
        new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    local_recoverable: true,
                    destroys_outside_repo: false,
                    destroys_history_or_secrets: false,
                    reason: 'doctor_dry_run',
                  }),
                },
              },
            ],
          }),
          { status: 200 },
        ),
    })
    const dryRun = await traced.evaluate({
      text: 'git status',
      context: { cwd: process.cwd(), repoRoot: process.cwd() },
    })
    if (
      dryRun.reason.startsWith('openai_compatible_') ||
      dryRun.reason === 'outbound_scrub_failed'
    ) {
      judgeShadowAdvisory(warnings, `HTTP judge dry-run failed: ${dryRun.reason}`)
    } else {
      notes.push('HTTP judge dry-run succeeded.')
    }
  }

  const factoryJudge = createJudgeFromConfig(config, { repoRoot })
  if (factoryJudge.lastTrace?.transport) {
    notes.push(`Factory transport: ${factoryJudge.lastTrace.transport}`)
  }

  if (config.judge.runtime?.session.enabled) {
    notes.push('Judge session transport: enabled')
    const activeBrokers = listRepoJudgeSessionBrokers()
    if (activeBrokers.includes(repoRoot)) {
      notes.push(`Active session broker for repo: ${repoRoot}`)
    }
  } else {
    notes.push('Judge session transport: disabled (default)')
  }

  return { issues, warnings, notes, modelCheck }
}

export async function stopJudgeSessionBrokers(repoRoot: string, stateDir: string): Promise<number> {
  let stopped = 0
  stopped += stopRepoJudgeSessionBroker(repoRoot, 'manual_stop')
  stopped += await stopJudgeBrokerDaemon(stateDir)
  await clearJudgeSessionKillSwitch(stateDir)
  return stopped
}

export function stopInProcessJudgeSessionBrokers(repoRoot?: string): number {
  if (repoRoot) {
    return stopRepoJudgeSessionBroker(repoRoot, 'manual_stop')
  }
  let stopped = 0
  for (const root of listRepoJudgeSessionBrokers()) {
    stopped += stopRepoJudgeSessionBroker(root, 'manual_stop')
  }
  return stopped
}
