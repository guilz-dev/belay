import path from 'node:path'

import { canonicalStringify, hashValue } from '../fingerprint.js'
import { validateManifestEffectTemplate } from './effect-template.js'
import { parseStrictJson } from './strict-json.js'
import type { ArgvMatcherV1, EffectManifestRuleV1, EffectManifestV1 } from './types.js'

export const MAX_EFFECT_MANIFEST_RULES = 64
export const MAX_EFFECT_MANIFEST_ARGV = 64
const MAX_EFFECTS = 64
const MAX_EVIDENCE = 64
const PORTABLE_NAME = /^[A-Za-z0-9._-]+$/
const CAPTURE_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/
const SHA256 = /^[a-f0-9]{64}$/

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function hasOnlyKeys(record: Record<string, unknown>, keys: readonly string[]): boolean {
  const allowed = new Set(keys)
  return Object.keys(record).every((key) => allowed.has(key))
}

function isCanonicalString(value: unknown): value is string {
  return typeof value === 'string' && value === value.normalize('NFC') && !value.includes('\0')
}

function hasCanonicalJsonShape(
  value: unknown,
  depth = 0,
  seen: WeakSet<object> = new WeakSet(),
): boolean {
  if (depth > 32) {
    return false
  }
  if (value === null || typeof value === 'boolean') {
    return true
  }
  if (typeof value === 'string') {
    return isCanonicalString(value)
  }
  if (typeof value === 'number') {
    return Number.isFinite(value)
  }
  if (typeof value !== 'object' || seen.has(value)) {
    return false
  }
  seen.add(value)
  const valid = Array.isArray(value)
    ? value.every((entry) => hasCanonicalJsonShape(entry, depth + 1, seen))
    : Object.entries(value).every(
        ([key, entry]) => isCanonicalString(key) && hasCanonicalJsonShape(entry, depth + 1, seen),
      )
  seen.delete(value)
  return valid
}

function isSafeName(value: unknown, pattern = PORTABLE_NAME): value is string {
  return (
    isCanonicalString(value) &&
    value.length > 0 &&
    value !== '.' &&
    value !== '..' &&
    value.length <= 255 &&
    pattern.test(value)
  )
}

function parseArgvMatcher(raw: unknown): ArgvMatcherV1 | null {
  if (!isRecord(raw) || !isCanonicalString(raw.kind)) {
    return null
  }
  if (raw.kind === 'literal') {
    return hasOnlyKeys(raw, ['kind', 'value']) && isCanonicalString(raw.value)
      ? { kind: 'literal', value: raw.value }
      : null
  }
  if (raw.kind === 'enum') {
    if (
      !hasOnlyKeys(raw, ['kind', 'name', 'values']) ||
      !isSafeName(raw.name, CAPTURE_NAME) ||
      !Array.isArray(raw.values) ||
      raw.values.length === 0 ||
      raw.values.length > MAX_EFFECT_MANIFEST_ARGV ||
      !raw.values.every(isCanonicalString) ||
      new Set(raw.values).size !== raw.values.length
    ) {
      return null
    }
    return { kind: 'enum', name: raw.name, values: [...raw.values] }
  }
  if (raw.kind === 'integer') {
    if (
      !hasOnlyKeys(raw, ['kind', 'name', 'min', 'max']) ||
      !isSafeName(raw.name, CAPTURE_NAME) ||
      (raw.min !== undefined && !Number.isSafeInteger(raw.min)) ||
      (raw.max !== undefined && !Number.isSafeInteger(raw.max)) ||
      (typeof raw.min === 'number' && typeof raw.max === 'number' && raw.min > raw.max)
    ) {
      return null
    }
    return {
      kind: 'integer',
      name: raw.name,
      ...(typeof raw.min === 'number' ? { min: raw.min } : {}),
      ...(typeof raw.max === 'number' ? { max: raw.max } : {}),
    }
  }
  if (raw.kind === 'path' || raw.kind === 'host' || raw.kind === 'token') {
    return hasOnlyKeys(raw, ['kind', 'name']) && isSafeName(raw.name, CAPTURE_NAME)
      ? { kind: raw.kind, name: raw.name }
      : null
  }
  return null
}

function parseCommand(raw: unknown): EffectManifestV1['command'] | null {
  if (
    !isRecord(raw) ||
    !hasOnlyKeys(raw, ['basename', 'canonicalPath', 'sha256', 'kind', 'interpreter']) ||
    !isSafeName(raw.basename) ||
    !isCanonicalString(raw.canonicalPath) ||
    !path.isAbsolute(raw.canonicalPath) ||
    !isCanonicalString(raw.sha256) ||
    !SHA256.test(raw.sha256) ||
    (raw.kind !== 'native' && raw.kind !== 'script')
  ) {
    return null
  }
  if (raw.kind === 'native') {
    return raw.interpreter === undefined
      ? {
          basename: raw.basename,
          canonicalPath: raw.canonicalPath,
          sha256: raw.sha256,
          kind: 'native',
        }
      : null
  }
  if (
    !isRecord(raw.interpreter) ||
    !hasOnlyKeys(raw.interpreter, ['canonicalPath', 'sha256']) ||
    !isCanonicalString(raw.interpreter.canonicalPath) ||
    !path.isAbsolute(raw.interpreter.canonicalPath) ||
    !isCanonicalString(raw.interpreter.sha256) ||
    !SHA256.test(raw.interpreter.sha256)
  ) {
    return null
  }
  return {
    basename: raw.basename,
    canonicalPath: raw.canonicalPath,
    sha256: raw.sha256,
    kind: 'script',
    interpreter: {
      canonicalPath: raw.interpreter.canonicalPath,
      sha256: raw.interpreter.sha256,
    },
  }
}

function parseEvidence(raw: unknown): unknown[] | null {
  if (!Array.isArray(raw) || raw.length > MAX_EVIDENCE) {
    return null
  }
  const parsed: unknown[] = []
  for (const entry of raw) {
    if (
      !isRecord(entry) ||
      !hasOnlyKeys(entry, ['kind', 'source', 'sha256']) ||
      !isCanonicalString(entry.kind) ||
      !isCanonicalString(entry.source) ||
      (entry.sha256 !== undefined &&
        (!isCanonicalString(entry.sha256) || !SHA256.test(entry.sha256)))
    ) {
      return null
    }
    parsed.push({
      kind: entry.kind,
      source: entry.source,
      ...(typeof entry.sha256 === 'string' ? { sha256: entry.sha256 } : {}),
    })
  }
  return parsed
}

function parseRule(raw: unknown): EffectManifestRuleV1 | null {
  if (
    !isRecord(raw) ||
    !hasOnlyKeys(raw, ['id', 'matcher', 'contract', 'assertion', 'inference']) ||
    !isSafeName(raw.id) ||
    raw.assertion !== 'complete-upper-bound'
  ) {
    return null
  }
  const matcher = raw.matcher
  if (
    !isRecord(matcher) ||
    !hasOnlyKeys(matcher, ['argv']) ||
    !Array.isArray(matcher.argv) ||
    matcher.argv.length > MAX_EFFECT_MANIFEST_ARGV
  ) {
    return null
  }
  const argv: ArgvMatcherV1[] = []
  for (const token of matcher.argv) {
    const parsed = parseArgvMatcher(token)
    if (!parsed) {
      return null
    }
    argv.push(parsed)
  }
  const captureNames = argv.flatMap((entry) => (entry.kind === 'literal' ? [] : [entry.name]))
  if (new Set(captureNames).size !== captureNames.length) {
    return null
  }

  const contract = raw.contract
  if (
    !isRecord(contract) ||
    !hasOnlyKeys(contract, ['processOperation', 'effects']) ||
    (contract.processOperation !== 'inspect' &&
      contract.processOperation !== 'spawn' &&
      contract.processOperation !== 'signal') ||
    !Array.isArray(contract.effects) ||
    contract.effects.length > MAX_EFFECTS
  ) {
    return null
  }
  const effects: EffectManifestRuleV1['contract']['effects'] = []
  for (const effect of contract.effects) {
    if (
      !isRecord(effect) ||
      !hasOnlyKeys(effect, ['tag', 'action', 'resource']) ||
      !isCanonicalString(effect.tag) ||
      !isCanonicalString(effect.action) ||
      !isRecord(effect.resource)
    ) {
      return null
    }
    const template = { tag: effect.tag, action: effect.action, resource: effect.resource }
    if (!validateManifestEffectTemplate(template).ok) {
      return null
    }
    effects.push(template)
  }

  const inference = raw.inference
  if (
    !isRecord(inference) ||
    !hasOnlyKeys(inference, [
      'method',
      'generatedAt',
      'generatorVersion',
      'model',
      'evidence',
      'warnings',
    ]) ||
    (inference.method !== 'static' &&
      inference.method !== 'llm-assisted' &&
      inference.method !== 'manual') ||
    !isCanonicalString(inference.generatedAt) ||
    !Number.isFinite(Date.parse(inference.generatedAt)) ||
    !isCanonicalString(inference.generatorVersion) ||
    (inference.model !== undefined && !isCanonicalString(inference.model)) ||
    !Array.isArray(inference.warnings) ||
    !inference.warnings.every(isCanonicalString)
  ) {
    return null
  }
  const evidence = parseEvidence(inference.evidence)
  if (!evidence) {
    return null
  }
  return {
    id: raw.id,
    matcher: { argv },
    contract: { processOperation: contract.processOperation, effects },
    assertion: 'complete-upper-bound',
    inference: {
      method: inference.method,
      generatedAt: inference.generatedAt,
      generatorVersion: inference.generatorVersion,
      ...(typeof inference.model === 'string' ? { model: inference.model } : {}),
      evidence,
      warnings: [...inference.warnings],
    },
  }
}

export function parseEffectManifestV1(raw: unknown): EffectManifestV1 | null {
  if (
    !hasCanonicalJsonShape(raw) ||
    !isRecord(raw) ||
    !hasOnlyKeys(raw, ['schemaVersion', 'command', 'fallback', 'rules']) ||
    raw.schemaVersion !== 1 ||
    raw.fallback !== 'indeterminate' ||
    !Array.isArray(raw.rules) ||
    raw.rules.length > MAX_EFFECT_MANIFEST_RULES
  ) {
    return null
  }
  const command = parseCommand(raw.command)
  if (!command) {
    return null
  }
  const rules: EffectManifestRuleV1[] = []
  for (const entry of raw.rules) {
    const rule = parseRule(entry)
    if (!rule) {
      return null
    }
    rules.push(rule)
  }
  if (new Set(rules.map((rule) => rule.id)).size !== rules.length) {
    return null
  }
  return { schemaVersion: 1, command, fallback: 'indeterminate', rules }
}

export function parseEffectManifestJsonV1(text: string): EffectManifestV1 | null {
  const parsed = parseStrictJson(text)
  return parsed.ok ? parseEffectManifestV1(parsed.value) : null
}

export function ruleFingerprint(manifest: EffectManifestV1, rule: EffectManifestRuleV1): string {
  return hashValue(
    canonicalStringify({
      schemaVersion: manifest.schemaVersion,
      command: manifest.command,
      fallback: manifest.fallback,
      id: rule.id,
      matcher: rule.matcher,
      contract: rule.contract,
      assertion: rule.assertion,
    }),
  )
}

export function manifestFingerprint(manifest: EffectManifestV1): string {
  return hashValue(canonicalStringify(manifest))
}
