import { repoLocalStateDirFor } from '../../config-io.js'
import { type BelayConfigV4, scrubOptionsFromConfig } from '../config.js'
import { resolveJudgeCredential } from '../judge-api-key.js'
import { hasValidCloudConsent, isCloudJudgeConfig } from '../judge-config.js'
import { getJudgeProviderSpec, inferProviderIdFromConfig } from '../verdict/judge-catalog.js'
import { scrubOutboundForJudge } from '../verdict/judge-outbound.js'
import { validateManifestEffectTemplate } from './effect-template.js'
import { parseStrictJson } from './strict-json.js'
import type { EffectManifestRuleV1, ManifestEffectTemplateV1 } from './types.js'

const MAX_LLM_PROMPT_BYTES = 32 * 1024
const MAX_LLM_OUTPUT_BYTES = 64 * 1024
const MAX_PROVIDER_RESPONSE_BYTES = 128 * 1024

export interface ManifestLlmInput {
  commandBasename: string
  canonicalPath: string
  argv: readonly string[]
}

export interface ManifestLlmDependencies {
  fetchImpl?: typeof fetch
}

export type ManifestLlmResult =
  | { ok: true; contract: EffectManifestRuleV1['contract']; model: string }
  | { ok: false; error: string }

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function hasOnlyKeys(record: Record<string, unknown>, keys: readonly string[]): boolean {
  const allowed = new Set(keys)
  return Object.keys(record).every((key) => allowed.has(key))
}

function parseContract(value: unknown): EffectManifestRuleV1['contract'] | null {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ['processOperation', 'effects']) ||
    (value.processOperation !== 'inspect' &&
      value.processOperation !== 'spawn' &&
      value.processOperation !== 'signal') ||
    !Array.isArray(value.effects) ||
    value.effects.length > 64
  ) {
    return null
  }
  const effects: ManifestEffectTemplateV1[] = []
  for (const raw of value.effects) {
    if (
      !isRecord(raw) ||
      !hasOnlyKeys(raw, ['tag', 'action', 'resource']) ||
      typeof raw.tag !== 'string' ||
      typeof raw.action !== 'string' ||
      !isRecord(raw.resource)
    ) {
      return null
    }
    const effect = { tag: raw.tag, action: raw.action, resource: raw.resource }
    if (!validateManifestEffectTemplate(effect).ok) {
      return null
    }
    effects.push(effect)
  }
  return { processOperation: value.processOperation, effects }
}

function contractFromText(text: string): EffectManifestRuleV1['contract'] | null {
  if (Buffer.byteLength(text, 'utf8') > MAX_LLM_OUTPUT_BYTES) {
    return null
  }
  const trimmed = text
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '')
  const parsed = parseStrictJson(trimmed)
  return parsed.ok ? parseContract(parsed.value) : null
}

function extractContract(value: unknown, depth = 0): EffectManifestRuleV1['contract'] | null {
  if (depth > 8) {
    return null
  }
  const direct = parseContract(value)
  if (direct) {
    return direct
  }
  if (typeof value === 'string') {
    return contractFromText(value)
  }
  if (Array.isArray(value)) {
    for (let index = value.length - 1; index >= 0; index -= 1) {
      const nested = extractContract(value[index], depth + 1)
      if (nested) {
        return nested
      }
    }
  } else if (isRecord(value)) {
    for (const key of [
      'result',
      'content',
      'text',
      'message',
      'output_text',
      'final',
      'response',
    ]) {
      if (key in value) {
        const nested = extractContract(value[key], depth + 1)
        if (nested) {
          return nested
        }
      }
    }
  }
  return null
}

function parseProviderOutput(raw: string): EffectManifestRuleV1['contract'] | null {
  if (Buffer.byteLength(raw, 'utf8') > MAX_LLM_OUTPUT_BYTES) {
    return null
  }
  const direct = contractFromText(raw)
  if (direct) {
    return direct
  }
  for (const line of raw.split(/\r?\n/).reverse()) {
    const parsed = parseStrictJson(line.trim())
    if (!parsed.ok) {
      continue
    }
    const extracted = extractContract(parsed.value)
    if (extracted) {
      return extracted
    }
  }
  return null
}

function buildPrompt(input: ManifestLlmInput): string {
  return [
    'Draft an Effect Manifest v1 effect contract for the exact invocation below.',
    'Return only one JSON object with exactly processOperation and effects.',
    'Allowed processOperation: inspect, spawn, signal.',
    'Allowed effects: fs.read/fs.write/secret.read path; network.connect with fixed protocol, mode, payload; git.ref.write with fixed scope; control_plane.write path; process.exec executable with fixed operation; indeterminate unknown.',
    'Do not return matcher, assertion, trust, confidence, markdown, or unknown fields.',
    'When effects cannot be established as a complete upper bound, return an indeterminate effect.',
    JSON.stringify({
      commandBasename: input.commandBasename,
      canonicalPath: input.canonicalPath,
      argv: input.argv,
    }),
  ].join('\n')
}

async function readBoundedProviderJson(response: Response): Promise<unknown> {
  const declared = Number(response.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > MAX_PROVIDER_RESPONSE_BYTES) {
    throw new Error('configured_provider_output_oversized')
  }
  if (!response.body) {
    throw new Error('configured_provider_empty_response')
  }
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  while (true) {
    const next = await reader.read()
    if (next.done) {
      break
    }
    total += next.value.byteLength
    if (total > MAX_PROVIDER_RESPONSE_BYTES) {
      await reader.cancel()
      throw new Error('configured_provider_output_oversized')
    }
    chunks.push(next.value)
  }
  const text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))
  const parsed = parseStrictJson(text)
  if (!parsed.ok) {
    throw new Error('configured_provider_response_invalid')
  }
  return parsed.value
}

async function runHttpProvider(
  prompt: string,
  repoRoot: string,
  config: BelayConfigV4,
  dependencies: ManifestLlmDependencies,
): Promise<string> {
  const fetchImpl = dependencies.fetchImpl ?? fetch
  const endpoint = config.judge.endpoint?.replace(/\/$/, '')
  if (!endpoint) {
    throw new Error('configured_provider_endpoint_missing')
  }
  if (config.judge.provider === 'ollama') {
    const response = await fetchImpl(`${endpoint}/api/generate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: config.judge.model,
        prompt,
        stream: false,
        format: 'json',
        keep_alive: config.judge.keepAlive ?? undefined,
      }),
      signal: AbortSignal.timeout(config.judge.timeoutMs),
    })
    if (!response.ok) {
      throw new Error(`configured_provider_http_${response.status}`)
    }
    const payload = (await readBoundedProviderJson(response)) as { response?: string }
    return payload.response ?? ''
  }
  if (isCloudJudgeConfig(config.judge) && !hasValidCloudConsent(config.judge)) {
    throw new Error('configured_provider_consent_missing')
  }
  const providerId = inferProviderIdFromConfig(config.judge)
  const credential = await resolveJudgeCredential({
    judge: config.judge,
    catalogSpec: getJudgeProviderSpec(providerId) ?? undefined,
    repoRoot,
    repoLocalStateDir: repoLocalStateDirFor(repoRoot, config),
    config,
  })
  if (!credential.key) {
    throw new Error('configured_provider_credential_missing')
  }
  const response = await fetchImpl(`${endpoint}/chat/completions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${credential.key}`,
    },
    body: JSON.stringify({
      model: config.judge.model,
      messages: [{ role: 'user', content: prompt }],
      response_format: { type: 'json_object' },
    }),
    signal: AbortSignal.timeout(config.judge.timeoutMs),
  })
  if (!response.ok) {
    throw new Error(`configured_provider_http_${response.status}`)
  }
  const payload = (await readBoundedProviderJson(response)) as {
    choices?: Array<{ message?: { content?: string } }>
  }
  return payload.choices?.[0]?.message?.content ?? ''
}

export async function inferManifestContractWithLlm(
  input: ManifestLlmInput,
  repoRoot: string,
  config: BelayConfigV4,
  dependencies: ManifestLlmDependencies = {},
): Promise<ManifestLlmResult> {
  const rawPrompt = buildPrompt(input)
  if (Buffer.byteLength(rawPrompt, 'utf8') > MAX_LLM_PROMPT_BYTES) {
    return { ok: false, error: 'llm_input_oversized' }
  }
  const scrubbed = scrubOutboundForJudge(rawPrompt, {
    sensitivePaths: config.classifier.sensitivePaths,
    scrubOptions: scrubOptionsFromConfig(config),
  })
  if (!scrubbed.ok) {
    return { ok: false, error: `llm_input_${scrubbed.reason}` }
  }
  if (config.judge.provider !== 'ollama' && !config.judge.endpoint) {
    return { ok: false, error: 'configured_provider_text_only_transport_required' }
  }
  try {
    const output = await runHttpProvider(scrubbed.text, repoRoot, config, dependencies)
    const contract = parseProviderOutput(output)
    return contract
      ? { ok: true, contract, model: config.judge.model }
      : { ok: false, error: 'llm_output_schema_invalid' }
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : 'configured_provider_unavailable',
    }
  }
}
