import type { BelayConfigV4 } from './config.js'
import { scrubOptionsFromConfig } from './config.js'
import { createCursorJudge, createOllamaJudge } from './v2/judge.js'
import { loadPinnedJudgeModels, resolveCursorModel } from './v2/judge-factory.js'

export interface JudgeDoctorResult {
  issues: string[]
  warnings: string[]
  notes: string[]
}

export async function diagnoseJudge(config: BelayConfigV4): Promise<JudgeDoctorResult> {
  const issues: string[] = []
  const warnings: string[] = []
  const notes: string[] = []
  const judge = config.judge

  notes.push(`Judge provider: ${judge.provider}`)
  notes.push(`Judge model requested: ${judge.model}`)

  if (config.policy.modelAssist.enabled) {
    warnings.push(
      'policy.modelAssist is enabled but is not wired to v2 Tier1. Use top-level judge instead.',
    )
  }

  if (judge.provider === 'cursor') {
    warnings.push(
      'Cloud judge egress is enabled. Commands are redacted (R23) before send, but path structure and intent may still leave the repo.',
    )
    if (!process.env.CURSOR_API_KEY?.trim()) {
      issues.push('CURSOR_API_KEY is not set. Tier1 cloud judge will fail closed to ask.')
    }
    const pinnedModels = await loadPinnedJudgeModels()
    const resolved = resolveCursorModel(judge.model, {
      autoResolved: pinnedModels['cursor'].autoResolved,
    })
    notes.push(`Resolved model: ${resolved.resolved}`)
    if (process.env.CURSOR_API_KEY?.trim()) {
      const traced = createCursorJudge({
        modelRequested: judge.model,
        modelResolved: resolved.resolved,
        timeoutMs: Math.min(judge.timeoutMs, 5000),
        endpoint: judge.endpoint,
        sensitivePaths: config.classifier.sensitivePaths,
        scrubOptions: scrubOptionsFromConfig(config),
        fetchImpl: async () =>
          new Response(
            JSON.stringify({
              choices: [
                {
                  message: {
                    content: JSON.stringify({
                      external_change: false,
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
      if (dryRun.reason.startsWith('cursor_') || dryRun.reason === 'outbound_scrub_failed') {
        issues.push(`Cursor judge dry-run failed: ${dryRun.reason}`)
      } else {
        notes.push('Cursor judge dry-run succeeded.')
      }
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
            external_change: false,
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
