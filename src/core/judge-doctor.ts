import { repoLocalStateDirFor } from '../config-io.js'
import type { BelayConfigV4 } from './config.js'
import { normalizeJudgeProvider, scrubOptionsFromConfig } from './config.js'
import { resolveJudgeCredential } from './judge-api-key.js'
import { assertJudgeEndpoint, hasValidCloudConsent, isCloudJudgeConfig } from './judge-config.js'
import { createOllamaJudge, createOpenAiCompatibleJudge } from './verdict/judge.js'
import { getJudgeProviderSpec, isRemovedProviderId, normalizeLegacyProviderId } from './verdict/judge-catalog.js'
import { resolveJudgeModel } from './verdict/judge-factory.js'

export interface JudgeDoctorResult {
  issues: string[]
  warnings: string[]
  notes: string[]
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
      `judge.providerId "${rawProviderId}" was removed; run belay judge use (ollama, codex, claude, cursor) to migrate.`,
    )
    return { issues, warnings, notes }
  }

  const providerId =
    judge.providerId && normalizeLegacyProviderId(judge.providerId)
      ? normalizeLegacyProviderId(judge.providerId)!
      : provider === 'ollama'
        ? 'ollama'
        : 'codex'
  const catalogSpec = getJudgeProviderSpec(providerId)

  notes.push(`Judge providerId: ${providerId}`)
  notes.push(`Judge driver: ${provider}`)
  notes.push(`Judge model requested: ${judge.model}`)

  if (config.policy.modelAssist.enabled) {
    warnings.push(
      'policy.modelAssist is enabled but is not wired to v2 Tier1. Use top-level judge instead.',
    )
  }

  if (providerId !== 'ollama' && provider !== 'ollama') {
    if (provider === 'openai-compatible') {
      if (isCloudJudgeConfig(judge) && !hasValidCloudConsent(judge)) {
        issues.push(
          'Cloud judge consent is not recorded. Tier1 cloud judge will fail closed until consent is granted.',
        )
      } else if (judge.cloudConsent?.accepted) {
        notes.push(`Cloud consent: accepted ${judge.cloudConsent.at} by ${judge.cloudConsent.by}`)
      }

      warnings.push(
        'Cloud judge egress is enabled. Commands are redacted (R23) before send, but path structure and intent may still leave the repo.',
      )

      if (judge.endpoint?.trim()) {
        notes.push(`OpenAI-compatible endpoint: ${judge.endpoint}`)
      }

      const repoLocalDir = repoLocalStateDirFor(repoRoot, config)
      const keyInfo = await resolveJudgeCredential({
        judge,
        catalogSpec: catalogSpec ?? undefined,
        repoRoot,
        repoLocalStateDir: repoLocalDir,
        config,
      })
      if (!keyInfo.key) {
        issues.push(
          'Judge API key is not set for the configured credential mode. Tier1 cloud judge will fail closed to ask.',
        )
      } else {
        notes.push(`Credential: ${keyInfo.mode} → ${keyInfo.source}`)
      }

      const resolved = resolveJudgeModel(judge)
      notes.push(`Resolved model: ${resolved.resolved}`)

      if (keyInfo.key && judge.endpoint?.trim() && hasValidCloudConsent(judge)) {
        try {
          assertJudgeEndpoint(judge)
        } catch {
          return { issues, warnings, notes }
        }
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
          issues.push(`OpenAI-compatible judge dry-run failed: ${dryRun.reason}`)
        } else {
          notes.push('OpenAI-compatible judge dry-run succeeded.')
        }
      }
      return { issues, warnings, notes }
    }

    if (provider === 'anthropic') {
      warnings.push(
        'Cloud judge egress is enabled. Commands are redacted (R23) before send, but path structure and intent may still leave the repo.',
      )
      const resolved = resolveJudgeModel(judge)
      notes.push(`Resolved model: ${resolved.resolved}`)
      return { issues, warnings, notes }
    }

    return { issues, warnings, notes }
  }

  const endpoint = judge.endpoint ?? 'http://127.0.0.1:11434'
  notes.push(`Ollama endpoint: ${endpoint}`)
  try {
    const response = await fetch(`${endpoint.replace(/\/$/, '')}/api/tags`, {
      signal: AbortSignal.timeout(3000),
    })
    if (!response.ok) {
      issues.push(`Ollama endpoint unreachable (HTTP ${response.status}). Tier1 will fail closed.`)
    } else {
      const tags = (await response.json()) as { models?: Array<{ name?: string }> }
      const names = (tags.models ?? []).map((entry) => entry.name ?? '')
      const hasModel = names.some(
        (name) => name === judge.model || name.startsWith(`${judge.model}:`),
      )
      if (!hasModel) {
        issues.push(`Ollama model "${judge.model}" is not present. Pull it before enforce mode.`)
      } else {
        notes.push(`Ollama model "${judge.model}" is available.`)
      }
    }
  } catch (error) {
    const detail = error instanceof Error ? error.message : 'connection failed'
    issues.push(`Ollama endpoint unreachable (${detail}). Tier1 will fail closed.`)
  }

  const warm = createOllamaJudge({
    model: judge.model,
    baseUrl: endpoint,
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

  return { issues, warnings, notes }
}
