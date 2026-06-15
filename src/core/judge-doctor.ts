import { repoLocalStateDirFor } from '../config-io.js'
import type { BelayConfigV4 } from './config.js'
import { normalizeJudgeProvider, scrubOptionsFromConfig } from './config.js'
import {
  discoverJudgeModels,
  modelPresenceFromDiscovery,
  type CheckJudgeModelPresenceResult,
} from './judge-model-discovery.js'
import { detectJudgeRuntimeCapabilities, resolveJudgeTransport } from './judge-runtime-detection.js'
import { resolveJudgeCredential } from './judge-api-key.js'
import { hasValidCloudConsent } from './judge-config.js'
import { createJudgeFromConfig } from './verdict/judge-factory.js'
import { createOllamaJudge, createOpenAiCompatibleJudge } from './verdict/judge.js'
import {
  getJudgeProviderCapabilities,
  getJudgeProviderSpec,
  isRemovedProviderId,
  normalizeLegacyProviderId,
} from './verdict/judge-catalog.js'
import { resolveJudgeModel } from './verdict/judge-factory.js'

export interface JudgeDoctorResult {
  issues: string[]
  warnings: string[]
  notes: string[]
  modelCheck?: CheckJudgeModelPresenceResult
}

export async function diagnoseJudge(
  config: BelayConfigV4,
  repoRoot: string = process.cwd(),
): Promise<JudgeDoctorResult> {
  const issues: string[] = []
  const warnings: string[] = []
  const notes: string[] = []
  const judge = config.judge
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

  notes.push(`Judge providerId: ${providerId}`)
  notes.push(`Judge driver: ${provider}`)
  notes.push(`Judge model requested: ${judge.model}`)
  notes.push(`Judge transport: ${transport}`)

  if (config.policy.modelAssist.enabled) {
    warnings.push(
      'policy.modelAssist is enabled but is not wired to v2 Tier1. Use top-level judge instead.',
    )
  }

  if (capabilities?.requiresConsent && !hasValidCloudConsent(judge) && transport === 'http') {
    issues.push(
      'Cloud judge consent is not recorded. Tier1 cloud judge will fail closed until consent is granted.',
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
  const discovery = await discoverJudgeModels({
    providerId,
    model: judge.model,
    endpoint,
  })
  const modelCheck = modelPresenceFromDiscovery(discovery, judge.model)
  notes.push(`Model check: ${modelCheck.status} (source: ${modelCheck.source})`)

  if (providerId === 'ollama') {
    notes.push(`Ollama endpoint: ${endpoint}`)
    if (discovery.modelIds.length === 0) {
      issues.push(`Ollama endpoint unreachable or returned no models. Tier1 will fail closed.`)
    } else {
      const hasModel = modelCheck.status === 'found'
      if (!hasModel) {
        issues.push(`Ollama model "${judge.model}" is not present. Pull it before enforce mode.`)
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
      issues.push(`Ollama warm call failed: ${warmResult.reason}`)
    } else {
      notes.push('Ollama warm call succeeded.')
    }
    return { issues, warnings, notes, modelCheck }
  }

  if (transport === 'unavailable') {
    issues.push(
      'No judge transport is available (configure endpoint or install native CLI). Tier1 will fail closed to ask.',
    )
    return { issues, warnings, notes, modelCheck }
  }

  if (transport.endsWith('-cli')) {
    if (!runtime.cliTransport) {
      issues.push(
        `Native CLI transport (${transport}) is not available. Tier1 judge will fail closed to ask.`,
      )
    } else if (!keyInfo.key && keyInfo.sourceKind !== 'host-session') {
      issues.push(
        'Judge API key is not set for the configured credential mode. Tier1 cloud judge will fail closed to ask.',
      )
    } else {
      notes.push(`Native CLI transport available: ${transport}`)
    }
    return { issues, warnings, notes, modelCheck }
  }

  if (judge.endpoint?.trim()) {
    notes.push(`HTTP endpoint: ${judge.endpoint}`)
  }

  if (!keyInfo.key) {
    issues.push(
      'Judge API key is not set for the configured credential mode. Tier1 cloud judge will fail closed to ask.',
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
      issues.push(`HTTP judge dry-run failed: ${dryRun.reason}`)
    } else {
      notes.push('HTTP judge dry-run succeeded.')
    }
  }

  const factoryJudge = createJudgeFromConfig(config, { repoRoot })
  if (factoryJudge.lastTrace?.transport) {
    notes.push(`Factory transport: ${factoryJudge.lastTrace.transport}`)
  }

  return { issues, warnings, notes, modelCheck }
}
