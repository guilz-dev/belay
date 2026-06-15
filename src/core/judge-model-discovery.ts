import { spawn } from 'node:child_process'

import type { BelayJudgeConfig } from './config.js'
import {
  getJudgeProviderSpec,
  inferProviderIdFromConfig,
  type JudgeProviderId,
  normalizeLegacyProviderId,
} from './verdict/judge-catalog.js'

const MODEL_DISCOVERY_SOURCES: Record<JudgeProviderId, string> = {
  ollama: 'ollama-tags',
  codex: 'codex-cli',
  claude: 'anthropic-models',
  cursor: 'cursor-agent',
}

export interface DiscoverJudgeModelsInput {
  providerId: string
  model: string
  endpoint: string | null
}

export interface DiscoverJudgeModelsResult {
  source: string
  modelIds: string[]
}

export interface CheckJudgeModelPresenceResult {
  status: 'found' | 'missing' | 'unverified'
  source: string
}

export type JudgeModelDiscoveryRunCommand = (
  command: string,
  args: string[],
  timeoutMs: number,
) => Promise<string>

export interface JudgeModelDiscoveryDeps {
  runCommand?: JudgeModelDiscoveryRunCommand
  fetch?: typeof fetch
  allowCliDiscovery?: boolean
}

function providerIdFromInput(providerId: string): JudgeProviderId {
  const normalized = normalizeLegacyProviderId(providerId)
  if (normalized) {
    return normalized
  }
  return inferProviderIdFromConfig({ providerId: providerId as BelayJudgeConfig['providerId'] })
}

function defaultAllowCliDiscovery(): boolean {
  if (process.env.BELAY_JUDGE_DISABLE_CLI_TRANSPORT === '1') {
    return false
  }
  return !process.env.VITEST && !process.env.VITEST_WORKER_ID
}

function resolveDeps(deps?: JudgeModelDiscoveryDeps): {
  runCommand: JudgeModelDiscoveryRunCommand
  fetchImpl: typeof fetch
  allowCliDiscovery: boolean
} {
  return {
    runCommand: deps?.runCommand ?? runCommandCapture,
    fetchImpl: deps?.fetch ?? fetch,
    allowCliDiscovery: deps?.allowCliDiscovery ?? defaultAllowCliDiscovery(),
  }
}

async function runCommandCapture(
  command: string,
  args: string[],
  timeoutMs: number,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => {
      child.kill('SIGTERM')
      reject(new Error(`${command} timed out`))
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
      reject(new Error(stderr.trim() || `${command} exited with code ${code ?? 'unknown'}`))
    })
  })
}

export function parseLineModelIds(raw: string): string[] {
  return raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
}

export function parseJsonModelIds(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw) as
      | Array<{ id?: string; name?: string; slug?: string }>
      | { models?: Array<{ id?: string; name?: string; slug?: string }> }
    const entries = Array.isArray(parsed) ? parsed : (parsed.models ?? [])
    return entries
      .map((entry) => entry.id?.trim() || entry.name?.trim() || entry.slug?.trim())
      .filter((id): id is string => Boolean(id))
  } catch {
    return parseLineModelIds(raw)
  }
}

async function discoverCursorModels(runCommand: JudgeModelDiscoveryRunCommand): Promise<string[]> {
  const raw = await runCommand('cursor-agent', ['--list-models'], 2000)
  const fromJson = parseJsonModelIds(raw)
  return fromJson.length > 0 ? fromJson : parseLineModelIds(raw)
}

async function discoverCodexModels(runCommand: JudgeModelDiscoveryRunCommand): Promise<string[]> {
  const raw = await runCommand('codex', ['debug', 'models'], 2000)
  const parsed = parseJsonModelIds(raw)
  if (parsed.length > 0) {
    return parsed
  }
  return parseLineModelIds(raw).filter((line) => line !== 'visibility=list')
}

async function discoverClaudeModels(
  endpoint: string | null,
  fetchImpl: typeof fetch,
): Promise<string[]> {
  const apiKey = process.env.ANTHROPIC_API_KEY?.trim() || process.env.BELAY_JUDGE_API_KEY?.trim()
  if (!apiKey) {
    return []
  }
  const base = (endpoint ?? 'https://api.anthropic.com').replace(/\/$/, '')
  const response = await fetchImpl(`${base}/v1/models`, {
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    signal: AbortSignal.timeout(5000),
  })
  if (!response.ok) {
    return []
  }
  const payload = (await response.json()) as { data?: Array<{ id?: string }> }
  return (payload.data ?? [])
    .map((entry) => entry.id?.trim())
    .filter((id): id is string => Boolean(id))
}

export async function discoverJudgeModels(
  input: DiscoverJudgeModelsInput,
  deps?: JudgeModelDiscoveryDeps,
): Promise<DiscoverJudgeModelsResult> {
  const { runCommand, fetchImpl, allowCliDiscovery } = resolveDeps(deps)
  const providerId = providerIdFromInput(input.providerId)
  const source = MODEL_DISCOVERY_SOURCES[providerId]

  if (providerId === 'ollama' && input.endpoint) {
    try {
      const response = await fetchImpl(`${input.endpoint.replace(/\/$/, '')}/api/tags`, {
        signal: AbortSignal.timeout(3000),
      })
      if (!response.ok) {
        return { source, modelIds: [] }
      }
      const payload = (await response.json()) as { models?: Array<{ name?: string }> }
      const modelIds = (payload.models ?? [])
        .map((entry) => entry.name?.trim())
        .filter((name): name is string => Boolean(name))
      return { source, modelIds }
    } catch {
      return { source, modelIds: [] }
    }
  }

  try {
    if (!allowCliDiscovery) {
      return { source, modelIds: [] }
    }
    if (providerId === 'cursor') {
      return { source, modelIds: await discoverCursorModels(runCommand) }
    }
    if (providerId === 'codex') {
      return { source, modelIds: await discoverCodexModels(runCommand) }
    }
    if (providerId === 'claude') {
      return { source, modelIds: await discoverClaudeModels(input.endpoint, fetchImpl) }
    }
  } catch {
    return { source, modelIds: [] }
  }

  if (getJudgeProviderSpec(providerId)) {
    return { source, modelIds: [] }
  }

  return { source, modelIds: [] }
}

export async function checkJudgeModelPresence(
  input: DiscoverJudgeModelsInput,
  deps?: JudgeModelDiscoveryDeps,
): Promise<CheckJudgeModelPresenceResult> {
  const discovery = await discoverJudgeModels(input, deps)
  return modelPresenceFromDiscovery(discovery, input.model)
}

export function modelPresenceFromDiscovery(
  discovery: DiscoverJudgeModelsResult,
  model: string,
): CheckJudgeModelPresenceResult {
  if (discovery.modelIds.length === 0) {
    return { status: 'unverified', source: discovery.source }
  }

  const requested = model.trim()
  const found = discovery.modelIds.some((id) => id === requested || id.startsWith(`${requested}:`))
  return {
    status: found ? 'found' : 'missing',
    source: discovery.source,
  }
}
