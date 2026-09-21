import { existsSync, readdirSync } from 'node:fs'
import path from 'node:path'

import { loadConfigFile, repoLocalStateDirFor } from '../config-io.js'
import type { BelayConfigV3 } from '../core/config.js'
import { manifestFingerprint, ruleFingerprint } from '../core/effect-manifest/codec.js'
import { commandIdentityFingerprint } from '../core/effect-manifest/command-identity.js'
import {
  resolveNativeExecutableIdentity,
  verifyStoredExecutableIdentity,
} from '../core/effect-manifest/executable-identity.js'
import { appendCandidateRule, buildCandidateRule } from '../core/effect-manifest/infer.js'
import { invocationMatchesManifestCommand } from '../core/effect-manifest/invocation-identity.js'
import {
  inferManifestContractWithLlm,
  type ManifestLlmDependencies,
} from '../core/effect-manifest/llm-infer.js'
import {
  loadEffectManifestSync,
  readEffectManifestFromPath,
} from '../core/effect-manifest/load-manifest-sync.js'
import { loadEffectManifestTrustSync } from '../core/effect-manifest/load-trust-sync.js'
import { manifestFilePath, normalizeManifestBasename } from '../core/effect-manifest/paths.js'
import {
  effectManifestTrustRecordPath,
  loadEffectManifestTrustRecord,
  saveEffectManifestTrustRecord,
} from '../core/effect-manifest/trust-store.js'
import type { EffectManifestV1 } from '../core/effect-manifest/types.js'
import {
  manifestAuthorityIssues,
  ruleIsTrustEligible,
  validateEffectManifestDocument,
} from '../core/effect-manifest/validate.js'
import { writeEffectManifestAtomic } from '../core/effect-manifest/write-manifest.js'
import { canonicalPath } from '../core/path-utils.js'
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
  /** Test seam; production uses the already configured judge provider. */
  llmDependencies?: ManifestLlmDependencies
}

function resolveRoots(options: ManifestCommandOptions): {
  repoRoot: string
  actionCwd: string
} {
  const repoRoot = canonicalPath(options.targetDir ?? process.cwd())
  const actionCwd = canonicalPath(options.actionCwd ?? repoRoot)
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
  if (
    record.commandIdentityFingerprint !== commandIdentityFingerprint(manifest.command) ||
    verifyStoredExecutableIdentity(manifest.command) !== 'ok' ||
    manifestAuthorityIssues(manifest).length > 0
  ) {
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
  let candidate = buildCandidateRule(tailArgv)
  if (options.llm) {
    const assisted = await inferManifestContractWithLlm(
      {
        commandBasename: identity.basename,
        canonicalPath: identity.canonicalPath,
        argv: tailArgv,
      },
      repoRoot,
      config,
      options.llmDependencies,
    )
    if (!assisted.ok) {
      return {
        ok: false as const,
        error: assisted.error,
        message: `LLM-assisted inference failed closed: ${assisted.error}.`,
      }
    }
    candidate = {
      ...candidate,
      contract: assisted.contract,
      inference: {
        ...candidate.inference,
        method: 'llm-assisted',
        model: assisted.model,
        warnings: [
          'Model output is an untrusted candidate. Verify the complete upper bound before trusting.',
        ],
      },
    }
  }
  const filePath = manifestFilePath(repoRoot, basename)
  const hasExisting = existsSync(filePath)
  const existing = hasExisting ? readEffectManifestFromPath(filePath) : null
  if (hasExisting && !existing) {
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
      const manifest = readEffectManifestFromPath(filePath)
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
  const loaded = loadEffectManifestSync(repoRoot, basename)
  if (!loaded.ok) {
    return {
      ok: false as const,
      error: loaded.reason,
      message:
        loaded.reason === 'no_manifest'
          ? `No manifest for ${basename}.`
          : `Manifest for ${basename} is unavailable: ${loaded.reason}.`,
    }
  }
  const manifest = loaded.manifest
  const trust = loadEffectManifestTrustSync(repoRoot, manifest.command.canonicalPath, config)
  const identityStatus = verifyStoredExecutableIdentity(manifest.command)
  const authorityValid = manifestAuthorityIssues(manifest).length === 0
  const trustRecordCurrent =
    trust !== null &&
    trust.commandIdentityFingerprint === commandIdentityFingerprint(manifest.command) &&
    path.resolve(trust.manifestPath) ===
      path.resolve(manifestFilePath(repoRoot, manifest.command.basename))
  const rules = manifest.rules.map((rule) => {
    const fingerprint = ruleFingerprint(manifest, rule)
    const trustEntry = trust?.trustedRules.find((entry) => entry.id === rule.id)
    const trustStatus = !trustEntry
      ? ('missing' as const)
      : !authorityValid
        ? ('invalid' as const)
        : identityStatus !== 'ok' ||
            !trustRecordCurrent ||
            trustEntry.ruleFingerprint !== fingerprint
          ? ('stale' as const)
          : ruleIsTrustEligible(rule)
            ? ('trusted' as const)
            : ('invalid' as const)
    return {
      id: rule.id,
      ruleFingerprint: fingerprint,
      trusted: trustStatus === 'trusted',
      trust: trustStatus,
      trustedAt: trustEntry?.trustedAt,
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
    identityStatus,
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
  const loaded = loadEffectManifestSync(repoRoot, basename)
  if (!loaded.ok) {
    return {
      ok: false as const,
      repoRoot,
      manifestPath: filePath,
      issues: [{ code: loaded.reason, message: `Manifest could not be loaded: ${loaded.reason}.` }],
      trustEligibleRuleIds: [],
      manifestFingerprint: undefined,
    }
  }
  const report = validateEffectManifestDocument(loaded.manifest, repoRoot)
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
  const loaded = loadEffectManifestSync(repoRoot, basename)
  if (!loaded.ok) {
    return {
      ok: false as const,
      error: loaded.reason,
      message:
        loaded.reason === 'no_manifest'
          ? `No manifest for ${basename}.`
          : `Manifest for ${basename} is unavailable: ${loaded.reason}.`,
    }
  }
  const manifest = loaded.manifest
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
  const validation = validateEffectManifestDocument(manifest, repoRoot)
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
  const currentExisting =
    existing?.repoRoot === repoRoot &&
    path.resolve(existing.manifestPath) === path.resolve(manifestPath) &&
    existing.commandIdentityFingerprint === commandIdentityFingerprint(manifest.command)
      ? existing
      : null
  const trustedRules = (currentExisting?.trustedRules ?? []).filter((entry) => entry.id !== rule.id)
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
  const loaded = loadEffectManifestSync(repoRoot, basename)
  if (!loaded.ok) {
    return {
      ok: false as const,
      error: loaded.reason,
      message:
        loaded.reason === 'no_manifest'
          ? `No manifest for ${basename}.`
          : `Manifest for ${basename} is unavailable: ${loaded.reason}.`,
    }
  }
  const manifest = loaded.manifest
  const config = await loadConfigFile(repoRoot)
  const stateDir = repoLocalStateDirFor(repoRoot, config)
  const recordPath = effectManifestTrustRecordPath(
    config,
    stateDir,
    repoRoot,
    manifest.command.canonicalPath,
  )
  const existing = await loadEffectManifestTrustRecord(recordPath)
  if (
    !existing ||
    existing.repoRoot !== repoRoot ||
    path.resolve(existing.manifestPath) !==
      path.resolve(manifestFilePath(repoRoot, manifest.command.basename))
  ) {
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
    `Executable: ${result.command.canonicalPath} (${result.identityStatus})`,
    '',
  ]
  for (const rule of result.rules) {
    lines.push(`${rule.id}\t${rule.trust}\t${rule.ruleFingerprint.slice(0, 12)}…`)
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
  return [
    result.assertion,
    `Matcher: ${JSON.stringify(result.matcher)}`,
    `Effect contract: ${JSON.stringify(result.contract)}`,
    `Trusted rule ${result.ruleId} (${result.ruleFingerprint.slice(0, 12)}…).`,
  ].join('\n')
}

export function formatManifestRevokeResult(
  result: Awaited<ReturnType<typeof manifestRevokeProject>>,
): string {
  if (!result.ok) {
    return result.message
  }
  return `Revoked trust for rule ${result.ruleId}.`
}
