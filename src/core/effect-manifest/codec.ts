import { canonicalStringify, hashValue } from '../fingerprint.js'
import type { ArgvMatcherV1, EffectManifestRuleV1, EffectManifestV1 } from './types.js'

const MAX_RULES = 64
const MAX_ARGV = 64

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function hasOnlyKeys(record: Record<string, unknown>, keys: readonly string[]): boolean {
  const allowed = new Set(keys)
  return Object.keys(record).every((key) => allowed.has(key))
}

function parseArgvMatcher(raw: unknown): ArgvMatcherV1 | null {
  if (!isRecord(raw) || typeof raw.kind !== 'string') {
    return null
  }
  if (raw.kind === 'literal') {
    return typeof raw.value === 'string' ? { kind: 'literal', value: raw.value } : null
  }
  if (raw.kind === 'enum' && typeof raw.name === 'string' && Array.isArray(raw.values)) {
    const values = raw.values.filter((entry): entry is string => typeof entry === 'string')
    return values.length > 0 ? { kind: 'enum', name: raw.name, values } : null
  }
  if (
    raw.kind === 'path' ||
    raw.kind === 'host' ||
    raw.kind === 'token' ||
    raw.kind === 'integer'
  ) {
    return typeof raw.name === 'string' ? { kind: raw.kind, name: raw.name } : null
  }
  return null
}

export function parseEffectManifestV1(raw: unknown): EffectManifestV1 | null {
  if (
    !isRecord(raw) ||
    !hasOnlyKeys(raw, ['schemaVersion', 'command', 'fallback', 'rules']) ||
    raw.schemaVersion !== 1 ||
    raw.fallback !== 'indeterminate'
  ) {
    return null
  }
  const command = raw.command
  if (
    !isRecord(command) ||
    !hasOnlyKeys(command, ['basename', 'canonicalPath', 'sha256', 'kind', 'interpreter']) ||
    typeof command.basename !== 'string' ||
    typeof command.canonicalPath !== 'string' ||
    typeof command.sha256 !== 'string' ||
    (command.kind !== 'native' && command.kind !== 'script')
  ) {
    return null
  }
  if (!Array.isArray(raw.rules) || raw.rules.length > MAX_RULES) {
    return null
  }
  const rules: EffectManifestRuleV1[] = []
  for (const entry of raw.rules) {
    if (
      !isRecord(entry) ||
      typeof entry.id !== 'string' ||
      entry.assertion !== 'complete-upper-bound'
    ) {
      return null
    }
    const matcher = entry.matcher
    if (!isRecord(matcher) || !Array.isArray(matcher.argv) || matcher.argv.length > MAX_ARGV) {
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
    const contract = entry.contract
    if (
      !isRecord(contract) ||
      (contract.processOperation !== 'inspect' &&
        contract.processOperation !== 'spawn' &&
        contract.processOperation !== 'signal') ||
      !Array.isArray(contract.effects)
    ) {
      return null
    }
    const inference = entry.inference
    if (
      !isRecord(inference) ||
      (inference.method !== 'static' &&
        inference.method !== 'llm-assisted' &&
        inference.method !== 'manual') ||
      typeof inference.generatedAt !== 'string' ||
      typeof inference.generatorVersion !== 'string' ||
      !Array.isArray(inference.evidence) ||
      !Array.isArray(inference.warnings)
    ) {
      return null
    }
    rules.push({
      id: entry.id,
      matcher: { argv },
      contract: {
        processOperation: contract.processOperation,
        effects: contract.effects as EffectManifestRuleV1['contract']['effects'],
      },
      assertion: 'complete-upper-bound',
      inference: {
        method: inference.method,
        generatedAt: inference.generatedAt,
        generatorVersion: inference.generatorVersion,
        ...(typeof inference.model === 'string' ? { model: inference.model } : {}),
        evidence: inference.evidence,
        warnings: inference.warnings.filter((w): w is string => typeof w === 'string'),
      },
    })
  }
  return {
    schemaVersion: 1,
    command: {
      basename: command.basename,
      canonicalPath: command.canonicalPath,
      sha256: command.sha256,
      kind: command.kind,
      ...(isRecord(command.interpreter) &&
      typeof command.interpreter.canonicalPath === 'string' &&
      typeof command.interpreter.sha256 === 'string'
        ? {
            interpreter: {
              canonicalPath: command.interpreter.canonicalPath,
              sha256: command.interpreter.sha256,
            },
          }
        : {}),
    },
    fallback: 'indeterminate',
    rules,
  }
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
