import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import path from 'node:path'

import { loadConfigFile, repoLocalStateDirFor } from '../config-io.js'
import type { BelayConfigV3 } from '../core/config.js'
import {
  manifestFingerprint,
  parseEffectManifestV1,
  ruleFingerprint,
} from '../core/effect-manifest/codec.js'
import { commandIdentityFingerprint } from '../core/effect-manifest/command-identity.js'
import { resolveNativeExecutableIdentity } from '../core/effect-manifest/executable-identity.js'
import {
  appendCandidateRule,
  buildCandidateRule,
  parseStoredManifest,
} from '../core/effect-manifest/infer.js'
import { invocationMatchesManifestCommand } from '../core/effect-manifest/invocation-identity.js'
import { loadEffectManifestSync } from '../core/effect-manifest/load-manifest-sync.js'
import { loadEffectManifestTrustSync } from '../core/effect-manifest/load-trust-sync.js'
import { manifestFilePath, normalizeManifestBasename } from '../core/effect-manifest/paths.js'
import {
  effectManifestTrustRecordPath,
  loadEffectManifestTrustRecord,
  saveEffectManifestTrustRecord,
} from '../core/effect-manifest/trust-store.js'
import type { EffectManifestV1 } from '../core/effect-manifest/types.js'
import {
  ruleIsTrustEligible,
  validateEffectManifestDocument,
} from '../core/effect-manifest/validate.js'
import { writeEffectManifestAtomic } from '../core/effect-manifest/write-manifest.js'
import { tokenizeShell } from '../core/shell-tokenizer.js'
import { PACKAGE_VERSION } from '../version.js'

export interface ManifestCommandOptions {
  targetDir?: string
  actionCwd?: string
  json?: boolean
  llm?: boolean
  ruleId?: string
  inferArgv?: string[]
  commandText?: string
}

function resolveRoots(options: ManifestCommandOptions): {
  repoRoot: string
  actionCwd: string
} {
  const repoRoot = path.resolve(options.targetDir ?? process.cwd())
  const actionCwd = path.resolve(options.actionCwd ?? repoRoot)
  return { repoRoot, actionCwd }
}

function parseInvocation(commandText: string): { head: string; argv: string[] } | null {
  const tokens = tokenizeShell(commandText.trim())
  if (tokens.length === 0) {
    return null
  }
  const [head, ...argv] = tokens
  if (!head) {
    return null
  }
  return { head, argv }
}

function loadManifestFile(repoRoot: string, basename: string): EffectManifestV1 | null {
  const loaded = loadEffectManifestSync(repoRoot, basename)
  return loaded.ok ? loaded.manifest : null
}

function identitiesMatch(
  left: EffectManifestV1['command'],
  right: EffectManifestV1['command'],
): boolean {
  return commandIdentityFingerprint(left) === commandIdentityFingerprint(right)
}

function activelyTrustedRuleIds(
  repoRoot: string,
  manifest: EffectManifestV1,
  config: BelayConfigV3,
): Set<string> {
  const record = loadEffectManifestTrustSync(repoRoot, manifest.command.canonicalPath, config)
  if (!record) {
    return new Set()
  }
  const expectedPath = manifestFilePath(repoRoot, manifest.command.basename)
  if (path.resolve(record.manifestPath) !== path.resolve(expectedPath)) {
    return new Set()
  }
  const trusted = new Set<string>()
  for (const rule of manifest.rules) {
    if (!ruleIsTrustEligible(rule)) {
      continue
    }
    const fingerprint = ruleFingerprint(manifest, rule)
    if (
      record.trustedRules.some(
        (entry) => entry.id === rule.id && entry.ruleFingerprint === fingerprint,
      )
    ) {
      trusted.add(rule.id)
    }
  }
  return trusted
}

export async function manifestInferProject(options: ManifestCommandOptions) {
  const { repoRoot, actionCwd } = resolveRoots(options)
  const config = await loadConfigFile(repoRoot)
  if (options.llm) {
    return {
      ok: false as const,
      error: 'llm_assisted_inference_unavailable',
      message: 'LLM-assisted manifest inference is not available in this build.',
    }
  }
  const argv = options.inferArgv ?? []
  if (argv.length === 0) {
    return {
      ok: false as const,
      error: 'missing_command',
      message: 'manifest infer requires a command after `--`.',
    }
  }
  const head = argv[0]
  if (!head) {
    return {
      ok: false as const,
      error: 'missing_command',
      message: 'manifest infer requires a command after `--`.',
    }
  }
  const basename = normalizeManifestBasename(head)
  if (!basename) {
    return {
      ok: false as const,
      error: 'ineligible_basename',
      message: 'Command basename is not eligible for effect manifests.',
    }
  }
  const identity = resolveNativeExecutableIdentity(head, actionCwd, process.env.PATH ?? '')
  if ('error' in identity) {
    return {
      ok: false as const,
      error: identity.error,
      message: 'Could not resolve a native executable identity without spawning.',
    }
  }
  const tailArgv = argv.slice(1)
  const candidate = buildCandidateRule(tailArgv)
  const filePath = manifestFilePath(repoRoot, basename)
  const existingRaw = existsSync(filePath)
    ? (JSON.parse(await readFile(filePath, 'utf8')) as unknown)
    : null
  const existing = existingRaw ? parseStoredManifest(existingRaw) : null
  if (existingRaw && !existing) {
    return {
      ok: false as const,
      error: 'schema_invalid',
      message: 'Existing manifest file is invalid.',
    }
  }
  let next: EffectManifestV1
  if (!existing) {
    next = {
      schemaVersion: 1,
      command: identity,
      fallback: 'indeterminate',
      rules: [candidate],
    }
  } else {
    if (!identitiesMatch(existing.command, identity)) {
      return {
        ok: false as const,
        error: 'identity_mismatch',
        message:
          'Existing manifest binds this basename to a different executable identity. Revoke trusted rules and archive the file before inferring again.',
      }
    }
    const trusted = activelyTrustedRuleIds(repoRoot, existing, config)
    if (trusted.has(candidate.id)) {
      return {
        ok: false as const,
        error: 'trusted_rule_exists',
        message: 'A trusted rule already exists for this argv; infer will not replace it.',
      }
    }
    const appended = appendCandidateRule(existing, candidate)
    if (!appended.ok) {
      return {
        ok: false as const,
        error: appended.reason,
        message:
          appended.reason === 'matcher_exists'
            ? 'An existing rule already matches this argv.'
            : 'A rule with this id already exists.',
      }
    }
    next = appended.manifest
  }
  await writeEffectManifestAtomic(filePath, next)
  return {
    ok: true as const,
    repoRoot,
    manifestPath: filePath,
    ruleId: candidate.id,
    manifestFingerprint: manifestFingerprint(next),
    belayVersion: PACKAGE_VERSION,
  }
}

export async function manifestListProject(options: ManifestCommandOptions) {
  const { repoRoot } = resolveRoots(options)
  const dir = path.join(repoRoot, '.belay', 'manifests')
  const entries: Array<{ basename: string; manifestPath: string; ruleCount: number }> = []
  if (existsSync(dir)) {
    for (const name of readdirSync(dir)) {
      if (!name.endsWith('.json')) {
        continue
      }
      const filePath = path.join(dir, name)
      const raw = JSON.parse(readFileSync(filePath, 'utf8')) as unknown
      const manifest = parseEffectManifestV1(raw)
      if (!manifest) {
        continue
      }
      entries.push({
        basename: manifest.command.basename,
        manifestPath: filePath,
        ruleCount: manifest.rules.length,
      })
    }
  }
  entries.sort((left, right) => left.basename.localeCompare(right.basename))
  return { ok: true as const, repoRoot, manifests: entries }
}

export async function manifestShowProject(options: ManifestCommandOptions) {
  const { repoRoot } = resolveRoots(options)
  const config = await loadConfigFile(repoRoot)
  const invocation = options.commandText ? parseInvocation(options.commandText) : null
  if (!invocation) {
    return { ok: false as const, error: 'missing_command', message: 'Command is required.' }
  }
  const basename = normalizeManifestBasename(invocation.head)
  if (!basename) {
    return {
      ok: false as const,
      error: 'ineligible_basename',
      message: 'Command basename is not eligible for effect manifests.',
    }
  }
  const manifest = loadManifestFile(repoRoot, basename)
  if (!manifest) {
    return {
      ok: false as const,
      error: 'no_manifest',
      message: `No manifest for ${basename}.`,
    }
  }
  const trust = loadEffectManifestTrustSync(repoRoot, manifest.command.canonicalPath, config)
  const rules = manifest.rules.map((rule) => {
    const fingerprint = ruleFingerprint(manifest, rule)
    const trusted = trust?.trustedRules.find(
      (entry) => entry.id === rule.id && entry.ruleFingerprint === fingerprint,
    )
    return {
      id: rule.id,
      ruleFingerprint: fingerprint,
      trusted: Boolean(trusted) && ruleIsTrustEligible(rule),
      trustedAt: trusted?.trustedAt,
      matcher: rule.matcher,
      contract: rule.contract,
    }
  })
  return {
    ok: true as const,
    repoRoot,
    manifestPath: manifestFilePath(repoRoot, basename),
    manifestFingerprint: manifestFingerprint(manifest),
    command: manifest.command,
    fallback: manifest.fallback,
    rules,
  }
}

export async function manifestValidateProject(options: ManifestCommandOptions) {
  const { repoRoot } = resolveRoots(options)
  const invocation = options.commandText ? parseInvocation(options.commandText) : null
  if (!invocation) {
    return { ok: false as const, error: 'missing_command', message: 'Command is required.' }
  }
  const basename = normalizeManifestBasename(invocation.head)
  if (!basename) {
    return {
      ok: false as const,
      error: 'ineligible_basename',
      message: 'Command basename is not eligible for effect manifests.',
    }
  }
  const filePath = manifestFilePath(repoRoot, basename)
  if (!existsSync(filePath)) {
    return {
      ok: false as const,
      error: 'no_manifest',
      message: `No manifest for ${basename}.`,
    }
  }
  const raw = JSON.parse(readFileSync(filePath, 'utf8')) as unknown
  const report = validateEffectManifestDocument(raw, repoRoot)
  return {
    ok: report.ok,
    repoRoot,
    manifestPath: filePath,
    issues: report.issues,
    trustEligibleRuleIds: report.trustEligibleRuleIds,
    manifestFingerprint: report.manifest ? manifestFingerprint(report.manifest) : undefined,
  }
}

export async function manifestTrustProject(options: ManifestCommandOptions) {
  const { repoRoot, actionCwd } = resolveRoots(options)
  if (!options.ruleId) {
    return { ok: false as const, error: 'missing_rule', message: '--rule is required.' }
  }
  const invocation = options.commandText ? parseInvocation(options.commandText) : null
  if (!invocation) {
    return { ok: false as const, error: 'missing_command', message: 'Command is required.' }
  }
  const basename = normalizeManifestBasename(invocation.head)
  if (!basename) {
    return {
      ok: false as const,
      error: 'ineligible_basename',
      message: 'Command basename is not eligible for effect manifests.',
    }
  }
  const manifest = loadManifestFile(repoRoot, basename)
  if (!manifest) {
    return {
      ok: false as const,
      error: 'no_manifest',
      message: `No manifest for ${basename}.`,
    }
  }
  if (
    !invocationMatchesManifestCommand(
      invocation.head,
      actionCwd,
      process.env.PATH ?? '',
      manifest.command,
    )
  ) {
    return {
      ok: false as const,
      error: 'invocation_identity_mismatch',
      message:
        'Command invocation does not resolve to the executable identity bound in the manifest.',
    }
  }
  const validation = validateEffectManifestDocument(
    JSON.parse(readFileSync(manifestFilePath(repoRoot, basename), 'utf8')) as unknown,
    repoRoot,
  )
  if (!validation.ok || !validation.manifest) {
    return {
      ok: false as const,
      error: 'manifest_invalid',
      message: 'Manifest failed validation; fix issues before trusting.',
      issues: validation.issues,
    }
  }
  const rule = manifest.rules.find((entry) => entry.id === options.ruleId)
  if (!rule) {
    return {
      ok: false as const,
      error: 'rule_not_found',
      message: `Rule ${options.ruleId} was not found.`,
    }
  }
  if (!ruleIsTrustEligible(rule)) {
    return {
      ok: false as const,
      error: 'rule_not_trust_eligible',
      message:
        'Rule still contains an indeterminate placeholder; complete the effect contract before trusting.',
    }
  }
  if (!validation.trustEligibleRuleIds.includes(rule.id)) {
    return {
      ok: false as const,
      error: 'rule_not_trust_eligible',
      message: 'Rule is not eligible for trust.',
    }
  }
  const config = await loadConfigFile(repoRoot)
  const stateDir = repoLocalStateDirFor(repoRoot, config)
  const manifestPath = manifestFilePath(repoRoot, basename)
  const recordPath = effectManifestTrustRecordPath(
    config,
    stateDir,
    repoRoot,
    manifest.command.canonicalPath,
  )
  const existing = await loadEffectManifestTrustRecord(recordPath)
  const fingerprint = ruleFingerprint(manifest, rule)
  const trustedAt = new Date().toISOString()
  const trustedRules = (existing?.trustedRules ?? []).filter((entry) => entry.id !== rule.id)
  trustedRules.push({ id: rule.id, ruleFingerprint: fingerprint, trustedAt })
  await saveEffectManifestTrustRecord(recordPath, {
    schemaVersion: 1,
    repoRoot,
    manifestPath,
    commandIdentityFingerprint: commandIdentityFingerprint(manifest.command),
    trustedRules,
  })
  return {
    ok: true as const,
    repoRoot,
    ruleId: rule.id,
    ruleFingerprint: fingerprint,
    manifestPath,
    trustRecordPath: recordPath,
    assertion:
      'You are asserting a reusable complete upper bound for this matcher and effect contract, not approving one execution.',
    matcher: rule.matcher,
    contract: rule.contract,
  }
}

export async function manifestRevokeProject(options: ManifestCommandOptions) {
  const { repoRoot } = resolveRoots(options)
  if (!options.ruleId) {
    return { ok: false as const, error: 'missing_rule', message: '--rule is required.' }
  }
  const invocation = options.commandText ? parseInvocation(options.commandText) : null
  if (!invocation) {
    return { ok: false as const, error: 'missing_command', message: 'Command is required.' }
  }
  const basename = normalizeManifestBasename(invocation.head)
  if (!basename) {
    return {
      ok: false as const,
      error: 'ineligible_basename',
      message: 'Command basename is not eligible for effect manifests.',
    }
  }
  const manifest = loadManifestFile(repoRoot, basename)
  if (!manifest) {
    return {
      ok: false as const,
      error: 'no_manifest',
      message: `No manifest for ${basename}.`,
    }
  }
  const config = await loadConfigFile(repoRoot)
  const stateDir = repoLocalStateDirFor(repoRoot, config)
  const recordPath = effectManifestTrustRecordPath(
    config,
    stateDir,
    repoRoot,
    manifest.command.canonicalPath,
  )
  const existing = await loadEffectManifestTrustRecord(recordPath)
  if (!existing) {
    return {
      ok: false as const,
      error: 'no_trust',
      message: 'No trust record exists for this executable.',
    }
  }
  const nextRules = existing.trustedRules.filter((entry) => entry.id !== options.ruleId)
  if (nextRules.length === existing.trustedRules.length) {
    return {
      ok: false as const,
      error: 'rule_not_trusted',
      message: `Rule ${options.ruleId} is not trusted.`,
    }
  }
  await saveEffectManifestTrustRecord(recordPath, {
    ...existing,
    trustedRules: nextRules,
  })
  return {
    ok: true as const,
    repoRoot,
    ruleId: options.ruleId,
    trustRecordPath: recordPath,
  }
}

export function formatManifestInferResult(
  result: Awaited<ReturnType<typeof manifestInferProject>>,
): string {
  if (!result.ok) {
    return result.message
  }
  return `Wrote candidate rule ${result.ruleId} to ${result.manifestPath}`
}

export function formatManifestListResult(
  result: Awaited<ReturnType<typeof manifestListProject>>,
): string {
  if (result.manifests.length === 0) {
    return 'No effect manifests in this repository.'
  }
  return result.manifests
    .map((entry) => `${entry.basename}\t${entry.ruleCount} rule(s)\t${entry.manifestPath}`)
    .join('\n')
}

export function formatManifestShowResult(
  result: Awaited<ReturnType<typeof manifestShowProject>>,
): string {
  if (!result.ok) {
    return result.message
  }
  const lines = [
    `Manifest: ${result.manifestPath}`,
    `Fingerprint: ${result.manifestFingerprint}`,
    `Executable: ${result.command.canonicalPath}`,
    '',
  ]
  for (const rule of result.rules) {
    lines.push(
      `${rule.id}\t${rule.trusted ? 'trusted' : 'candidate'}\t${rule.ruleFingerprint.slice(0, 12)}…`,
    )
  }
  return lines.join('\n')
}

export function formatManifestValidateResult(
  result: Awaited<ReturnType<typeof manifestValidateProject>>,
): string {
  if (!result.ok && 'message' in result && typeof result.message === 'string') {
    return result.message
  }
  if (result.ok) {
    return `Manifest is valid (${result.manifestPath}).`
  }
  return result.issues.map((issue) => `${issue.code}: ${issue.message}`).join('\n')
}

export function formatManifestTrustResult(
  result: Awaited<ReturnType<typeof manifestTrustProject>>,
): string {
  if (!result.ok) {
    return result.message
  }
  return `${result.assertion}\nTrusted rule ${result.ruleId} (${result.ruleFingerprint.slice(0, 12)}…).`
}

export function formatManifestRevokeResult(
  result: Awaited<ReturnType<typeof manifestRevokeProject>>,
): string {
  if (!result.ok) {
    return result.message
  }
  return `Revoked trust for rule ${result.ruleId}.`
}
