import { createHash } from 'node:crypto'
import path from 'node:path'

import type { BelayConfigV4 } from '../config.js'
import { isGitMetadataPath } from '../git-resource-identity.js'
import { matchesSensitivePath } from '../glob.js'
import { parseNetworkEndpoint } from '../network-endpoint.js'
import { canonicalPath, pathWithinRoot, resolveWorkspaceRootMatch } from '../path-utils.js'
import { tokenizeShell } from '../shell-tokenizer.js'
import type { VerdictEffect, VerdictLocation, VerdictOpacity } from '../verdict/types.js'
import {
  BOUNDARY_GRANT_ISSUER_CONTAINER,
  isPathWithinBoundaryMount,
  materializeContainerBoundaryGrant,
} from './boundary-grant-materialize.js'
import { boundaryVerifiedAllowEnabled } from './boundary-profile.js'
import type { CapabilityGrantV1 } from './grant.js'
import { isGrantScopeTooBroad } from './grant.js'
import { broadGrantTargetsRequest, grantMatchesRequest } from './grant-match.js'
import type { AuthorizationContext, PolicyDecision, PolicyEngine } from './policy-types.js'
import {
  CAPABILITY_REQUEST_VERSION,
  type CapabilityAction,
  type CapabilityEvidenceLevel,
  type CapabilityHookKind,
  type CapabilityRequestV1,
  type CapabilityResource,
} from './request.js'

export type PolicyAuthExtras = Pick<AuthorizationContext, 'grants' | 'attestation'> & {
  egressProxyActive?: boolean
  sensitivePaths?: string[]
}

export type EffectPolicyDisposition = 'allow' | 'allow_flagged' | 'ask'

export interface EffectRequirementPolicyInput {
  tag: string
  action: CapabilityAction
  resource: CapabilityResource
  evidence: {
    level: CapabilityEvidenceLevel
    signals: readonly string[]
    basis: readonly string[]
  }
  provenance?: unknown
}

export interface EffectRequirementPolicyContext {
  cwd: string
  repoRoot: string
  trustedWorkspaceRoots?: readonly string[]
  sensitivePaths?: readonly string[]
  protectedArtifactRoots?: readonly string[]
  grants?: readonly CapabilityGrantV1[]
  capabilityRequest?: CapabilityRequestV1
}

export interface EffectRequirementPolicyDecision extends PolicyDecision {
  effectDisposition: EffectPolicyDisposition
}

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '0:0:0:0:0:0:0:1'])
const DESTRUCTIVE_EFFECT_SIGNALS = new Set([
  'git_history_destructive',
  'git.destructive_history_write',
  'git.destructive_worktree_write',
])
const HIGH_STAKES_EFFECT_PATHS = [
  /(?:^|[/\\])(?:\.env(?:\..*)?|credentials?(?:\.json)?|secrets?|authorized_keys|id_(?:rsa|dsa|ecdsa|ed25519)|[^/\\]+\.pem|\.ssh[/\\]config|\.zshrc|\.bashrc|\.git-credentials|\.npmrc|\.netrc|\.kube[/\\]config|\.docker[/\\]config\.json|\.gnupg(?:[/\\].*)?|\.pypirc)(?:$|[/\\])/i,
  /(?:^|[/\\])application_default_credentials\.json$/i,
  /(?:^|[/\\])\.config[/\\]gcloud[/\\](?:application_default_credentials\.json|credentials\.db|access_tokens\.db|legacy_credentials(?:[/\\].*)?)$/i,
  /(?:^|[/\\])\.aws[/\\](?:credentials|config)$/i,
  /(?:^|[/\\])\.azure[/\\](?:accessTokens\.json|azureProfile\.json|msal_token_cache\.(?:bin|json)|service_principal_entries\.json)$/i,
  /(?:^|[/\\])\.terraform\.d[/\\]credentials\.tfrc\.json$/i,
  /(?:^|[/\\])\.config[/\\]gh[/\\]hosts\.ya?ml$/i,
  /(?:^|[/\\])\.oci[/\\]config$/i,
  /(?:^|[/\\])\.config[/\\]doctl[/\\]config\.ya?ml$/i,
] as const

function effectDecision(
  effectDisposition: EffectPolicyDisposition,
  reason: string,
  matchedRule: string,
  signals: readonly string[],
): EffectRequirementPolicyDecision {
  return {
    effectDisposition,
    outcome: effectDisposition === 'ask' ? 'require_approval' : 'allow',
    reason,
    signals: [...signals],
    matchedRule,
  }
}

function effectPathIsLocal(target: string, context: EffectRequirementPolicyContext): boolean {
  const resolved = resolveCapabilityPath(target, context.cwd)
  return (
    resolveWorkspaceRootMatch(
      context.repoRoot,
      [...(context.trustedWorkspaceRoots ?? [])],
      resolved,
    ) !== null
  )
}

function effectPathIsSecretOrCredentialPath(
  target: string,
  context: EffectRequirementPolicyContext,
): boolean {
  const resolved = resolveCapabilityPath(target, context.cwd)
  if (HIGH_STAKES_EFFECT_PATHS.some((pattern) => pattern.test(resolved))) {
    return true
  }
  const workspaceMatch = resolveWorkspaceRootMatch(
    context.repoRoot,
    [...(context.trustedWorkspaceRoots ?? [])],
    resolved,
  )
  if (!workspaceMatch) {
    return false
  }
  return matchesSensitivePath(workspaceMatch.relativePath.replaceAll('\\', '/'), [
    ...(context.sensitivePaths ?? []),
  ])
}

function effectPathIsControlPlaneArtifactPath(
  target: string,
  context: EffectRequirementPolicyContext,
): boolean {
  const resolved = resolveCapabilityPath(target, context.cwd)
  return (
    context.protectedArtifactRoots?.some((root) => pathWithinRoot(canonicalPath(root), resolved)) ??
    false
  )
}

function effectPathIsHighStakes(target: string, context: EffectRequirementPolicyContext): boolean {
  if (effectPathIsSecretOrCredentialPath(target, context)) {
    return true
  }
  if (effectPathIsControlPlaneArtifactPath(target, context)) {
    return true
  }
  const resolved = resolveCapabilityPath(target, context.cwd)
  if (isGitMetadataPath(resolved, context.repoRoot)) {
    return true
  }
  return false
}

/**
 * Policy for a lowered shell effect. It intentionally ignores executable
 * command names, segment heads, command text, and config allowlists.
 */
export function evaluateEffectRequirementPolicy(
  requirement: EffectRequirementPolicyInput,
  context: EffectRequirementPolicyContext,
): EffectRequirementPolicyDecision {
  const signals = [...requirement.evidence.signals]
  const capabilityRequest: CapabilityRequestV1 = context.capabilityRequest ?? {
    version: CAPABILITY_REQUEST_VERSION,
    principal: { repoRoot: context.repoRoot },
    action: requirement.action,
    resource: requirement.resource,
    context: {
      cwd: context.cwd,
      inputFingerprint: 'effect-plan',
      hookKind: 'shell',
      analysisBasis: [...requirement.evidence.basis],
    },
    evidence: {
      level: requirement.evidence.level,
      signals,
    },
  }
  if (signals.includes('forged_grant')) {
    return effectDecision('ask', 'grant_forgery', 'forbid.grant_forgery', [
      ...signals,
      'grant_forgery',
    ])
  }
  if (
    context.grants?.some(
      (grant) => isGrantScopeTooBroad(grant) && broadGrantTargetsRequest(grant, capabilityRequest),
    )
  ) {
    return effectDecision('ask', 'grant_scope_too_broad', 'forbid.broad_grant', [
      ...signals,
      'grant_scope_too_broad',
    ])
  }
  const matchedGrant =
    requirement.resource.kind === 'executable'
      ? null
      : findFreshGrant(capabilityRequest, [...(context.grants ?? [])])
  if (matchedGrant) {
    return effectDecision(
      'allow',
      'capability_grant',
      'grant.exact',
      grantDecisionSignals(capabilityRequest, matchedGrant),
    )
  }
  if (
    requirement.evidence.level === 'indeterminate' ||
    requirement.action === 'indeterminate' ||
    requirement.tag === 'indeterminate'
  ) {
    return effectDecision('ask', 'indeterminate_effect', 'effect.indeterminate', [
      ...signals,
      'indeterminate',
    ])
  }
  if (signals.some((signal) => DESTRUCTIVE_EFFECT_SIGNALS.has(signal))) {
    return effectDecision('ask', 'git_history_destructive', 'effect.destructive', signals)
  }
  if (signals.includes('belay_control_plane_command')) {
    return effectDecision(
      'allow',
      'belay_control_plane_command',
      'effect.belay_control_plane_command',
      signals,
    )
  }

  switch (requirement.action) {
    case 'fs.read':
      if (requirement.resource.kind === 'path') {
        if (effectPathIsSecretOrCredentialPath(requirement.resource.path, context)) {
          return effectDecision('ask', 'high_stakes_path', 'effect.fs_read_high_stakes', [
            ...signals,
            'sensitive_path_read',
          ])
        }
      }
      return effectDecision('allow', 'read_only', 'effect.fs_read', signals)
    case 'fs.write':
      if (requirement.resource.kind === 'package-cache') {
        return effectDecision(
          'allow_flagged',
          'repo_local_mutation',
          'effect.package_cache_write',
          signals,
        )
      }
      if (requirement.resource.kind !== 'path') {
        return effectDecision('ask', 'indeterminate_effect', 'effect.fs_write_unknown', signals)
      }
      if (effectPathIsControlPlaneArtifactPath(requirement.resource.path, context)) {
        return effectDecision('ask', 'control_plane_mutation', 'effect.control_plane_write', [
          ...signals,
          'control_plane_path',
        ])
      }
      if (effectPathIsHighStakes(requirement.resource.path, context)) {
        return effectDecision('ask', 'high_stakes_path', 'effect.fs_write_high_stakes', [
          ...signals,
          'tier1_catastrophic',
          ...(!effectPathIsLocal(requirement.resource.path, context)
            ? ['outside_repo_secret_credential_path']
            : []),
        ])
      }
      return effectPathIsLocal(requirement.resource.path, context)
        ? effectDecision('allow_flagged', 'repo_local_mutation', 'effect.fs_write_local', signals)
        : effectDecision('ask', 'outside_repo_mutation', 'effect.fs_write_outside', signals)
    case 'process.exec':
      if (requirement.resource.kind !== 'executable') {
        return effectDecision('ask', 'indeterminate_effect', 'effect.process_unknown', signals)
      }
      if (requirement.resource.operation === 'inspect') {
        return effectDecision('allow', 'read_only', 'effect.process_inspect', signals)
      }
      if (requirement.resource.operation === 'spawn') {
        return effectDecision(
          'allow_flagged',
          'repo_local_mutation',
          'effect.process_spawn',
          signals,
        )
      }
      return effectDecision('ask', 'high_stakes_path', 'effect.process_signal', signals)
    case 'network.connect': {
      if (
        requirement.tag === 'network.acquire' ||
        requirement.resource.kind !== 'network' ||
        !requirement.resource.mode ||
        !requirement.resource.payload
      ) {
        return effectDecision('ask', 'external_effect', 'effect.network_unknown', signals)
      }
      const loopback = LOOPBACK_HOSTS.has(
        requirement.resource.host.replace(/^\[|\]$/g, '').toLowerCase(),
      )
      if (requirement.resource.payload === 'secret') {
        return effectDecision('ask', 'high_stakes_path', 'effect.network_secret_payload', [
          ...signals,
          'secret_payload_send',
        ])
      }
      if (loopback && requirement.resource.mode === 'mutate') {
        return effectDecision(
          'allow_flagged',
          'repo_local_mutation',
          'effect.network_loopback_mutation',
          signals,
        )
      }
      if (requirement.resource.mode === 'read' && requirement.resource.payload === 'none') {
        return effectDecision('allow', 'read_only', 'effect.network_read', signals)
      }
      return effectDecision('ask', 'external_effect', 'effect.network_remote_mutation', signals)
    }
    case 'git.ref.write':
      if (requirement.resource.kind !== 'git-ref' || !requirement.resource.scope) {
        return effectDecision('ask', 'indeterminate_effect', 'effect.git_ref_unknown', signals)
      }
      if (requirement.resource.scope === 'remote') {
        return effectDecision('ask', 'external_effect', 'effect.git_ref_remote', signals)
      }
      if (
        requirement.resource.repoPath &&
        !effectPathIsLocal(requirement.resource.repoPath, context)
      ) {
        return effectDecision('ask', 'outside_repo_mutation', 'effect.git_ref_outside', signals)
      }
      return effectDecision('allow_flagged', 'repo_local_mutation', 'effect.git_ref_local', signals)
    case 'secret.read':
      return effectDecision('ask', 'high_stakes_path', 'effect.secret_read', signals)
    case 'control_plane.write':
      return effectDecision('ask', 'control_plane_mutation', 'effect.control_plane_write', signals)
    default:
      return effectDecision('ask', 'indeterminate_effect', 'effect.unknown', signals)
  }
}

function enrichAuthWithMaterializedGrants(
  request: CapabilityRequestV1,
  config: BelayConfigV4,
  auth?: PolicyAuthExtras,
): PolicyAuthExtras | undefined {
  if (!auth?.attestation || !boundaryVerifiedAllowEnabled(auth.attestation)) {
    return auth
  }
  const materialized = materializeContainerBoundaryGrant(request, {
    attestation: auth.attestation,
    mountRoot: request.context.cwd,
    egressProxyActive: auth.egressProxyActive === true,
    existingGrants: auth.grants,
    sensitivePaths: auth.sensitivePaths ?? config.classifier.sensitivePaths,
  })
  if (!materialized) {
    return auth
  }
  return { ...auth, grants: [...(auth.grants ?? []), materialized] }
}

function buildAuthorizationContext(
  config: BelayConfigV4,
  trustedWorkspaceRoots: string[] | undefined,
  auth?: PolicyAuthExtras,
): AuthorizationContext {
  return {
    config,
    grants: auth?.grants,
    attestation: auth?.attestation ?? null,
    trustedWorkspaceRoots,
  }
}

export interface ShellCapabilityAnalysis {
  command: string
  hookKind: CapabilityHookKind
  segmentHead: string
  effect: VerdictEffect
  location: VerdictLocation
  opacity: VerdictOpacity
  egressClass?: 'read' | 'destructive' | 'ambiguous'
  pathArgs: string[]
  /** Verdict-resolved canonical paths aligned with pathArgs (preferred for policy resource selection). */
  resolvedPathTargets?: string[]
  signals: string[]
  cwd: string
  repoRoot: string
  inputFingerprint: string
  adapter?: string
  trustedWorkspaceRoots?: string[]
  sensitivePaths?: string[]
  protectedArtifactRoots?: string[]
}

export interface FileMutationCapabilityAnalysis {
  hookKind: CapabilityHookKind
  toolKind: string
  filePath: string
  resolvedPath: string
  repoRoot: string
  cwd: string
  inputFingerprint: string
  signals: string[]
  isDelete: boolean
  locationLabel: 'repo_local' | 'outside_repo' | 'sensitive_path' | 'control_plane'
  trustedWorkspaceRoots?: string[]
  sensitivePaths?: string[]
  adapter?: string
}

export interface SubagentCapabilityAnalysis {
  subagentType: string
  summary: string
  repoRoot: string
  cwd: string
  inputFingerprint: string
  signals: string[]
  adapter?: string
}

export function buildSubagentCapabilityRequest(
  analysis: SubagentCapabilityAnalysis,
): CapabilityRequestV1 {
  return {
    version: CAPABILITY_REQUEST_VERSION,
    principal: {
      adapter: analysis.adapter,
      repoRoot: analysis.repoRoot,
      sessionHash: hashSession(`${analysis.repoRoot}:${analysis.cwd}`),
    },
    action: 'process.exec',
    resource: { kind: 'executable', command: analysis.subagentType },
    context: {
      cwd: analysis.cwd,
      inputFingerprint: analysis.inputFingerprint,
      hookKind: 'subagent',
      analysisBasis: [`subagent:${analysis.subagentType}`],
    },
    evidence: {
      level: 'possible',
      signals: [...analysis.signals],
    },
  }
}

export function evaluateSubagentPolicy(
  analysis: SubagentCapabilityAnalysis,
  config: BelayConfigV4,
  auth?: PolicyAuthExtras,
): { request: CapabilityRequestV1; decision: PolicyDecision } {
  const request = buildSubagentCapabilityRequest(analysis)
  const enriched = enrichAuthWithMaterializedGrants(request, config, auth)
  const decision = getDefaultPolicyEngine().evaluate(
    request,
    buildAuthorizationContext(config, undefined, enriched),
  )
  return { request, decision }
}

function hashSession(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 16)
}

function resolveCapabilityPath(targetPath: string, cwd: string): string {
  const joined = path.isAbsolute(targetPath) ? targetPath : path.join(cwd, targetPath)
  return canonicalPath(joined)
}

function evidenceLevelForOpacity(opacity: VerdictOpacity): CapabilityEvidenceLevel {
  if (opacity === 'transparent' || opacity === 'recursive') {
    return 'certain'
  }
  if (opacity === 'opaque') {
    return 'possible'
  }
  return 'indeterminate'
}

function isGitRefWrite(analysis: ShellCapabilityAnalysis): boolean {
  if (analysis.segmentHead !== 'git') {
    return false
  }
  return analysis.signals.includes('git.push')
}

function actionForShellAnalysis(analysis: ShellCapabilityAnalysis): CapabilityAction {
  if (isGitRefWrite(analysis)) {
    return 'git.ref.write'
  }
  if (
    analysis.effect === 'remote_mutation' ||
    analysis.egressClass === 'ambiguous' ||
    analysis.egressClass === 'read' ||
    analysis.egressClass === 'destructive'
  ) {
    return 'network.connect'
  }
  if (analysis.opacity === 'unparseable' || analysis.effect === 'unknown') {
    return 'indeterminate'
  }
  if (analysis.effect === 'read_only') {
    return 'fs.read'
  }
  if (analysis.location === 'external') {
    return 'network.connect'
  }
  if (analysis.effect === 'local_mutation') {
    return 'fs.write'
  }
  return 'indeterminate'
}

function resourcePathForShellAnalysis(analysis: ShellCapabilityAnalysis): string | null {
  const targets =
    analysis.resolvedPathTargets && analysis.resolvedPathTargets.length > 0
      ? analysis.resolvedPathTargets
      : analysis.pathArgs
  if (targets.length === 0) {
    return null
  }
  const repoRoot = canonicalPath(analysis.repoRoot)
  const resolved = targets.map((target) =>
    analysis.resolvedPathTargets?.length
      ? canonicalPath(target)
      : resolveCapabilityPath(target, analysis.cwd),
  )
  const [first] = resolved
  if (!first) {
    return null
  }
  if (analysis.effect === 'local_mutation') {
    const outside = resolved.find((candidate) => !pathWithinRoot(repoRoot, candidate))
    return outside ?? resolved.at(-1) ?? first
  }
  return first
}

function resourceForShellAnalysis(analysis: ShellCapabilityAnalysis): CapabilityResource {
  if (isGitRefWrite(analysis)) {
    return { kind: 'git-ref', ref: 'push' }
  }
  if (isNetworkShellAnalysis(analysis)) {
    const exact = exactNetworkResources(analysis)
    return (
      (exact.length === 1 ? exact[0] : undefined) ?? {
        kind: 'network',
        host: '*',
        protocol: 'unknown',
      }
    )
  }
  const resourcePath = resourcePathForShellAnalysis(analysis)
  if (resourcePath) {
    return { kind: 'path', path: resourcePath }
  }
  return { kind: 'executable', command: analysis.segmentHead }
}

function isNetworkShellAnalysis(analysis: ShellCapabilityAnalysis): boolean {
  return (
    analysis.egressClass === 'ambiguous' ||
    analysis.egressClass === 'read' ||
    analysis.egressClass === 'destructive' ||
    analysis.location === 'external'
  )
}

const SCP_STYLE_COMMANDS = new Set(['git', 'rsync', 'scp'])
const PACKAGE_SPEC_COMMANDS = new Set(['bun', 'npm', 'npx', 'pnpm', 'yarn'])
const NETWORK_VALUE_OPTIONS = new Set(['--registry', '--url'])
const GIT_OPTIONS_WITH_VALUE = new Set([
  '-C',
  '-b',
  '-c',
  '-o',
  '--branch',
  '--config',
  '--depth',
  '--filter',
  '--git-dir',
  '--namespace',
  '--origin',
  '--reference',
  '--separate-git-dir',
  '--upload-pack',
  '--work-tree',
])

function gitRemoteOperand(tokens: string[]): string | null {
  let cursor = 1
  while (cursor < tokens.length) {
    const token = tokens[cursor]
    if (!token) {
      return null
    }
    if (GIT_OPTIONS_WITH_VALUE.has(token)) {
      cursor += 2
      continue
    }
    if (token.startsWith('-')) {
      cursor += 1
      continue
    }
    break
  }

  const subcommand = tokens[cursor]
  if (!subcommand) {
    return null
  }
  const positionals: string[] = []
  let skipOptionValue = false
  for (const token of tokens.slice(cursor + 1)) {
    if (skipOptionValue) {
      skipOptionValue = false
      continue
    }
    if (GIT_OPTIONS_WITH_VALUE.has(token)) {
      skipOptionValue = true
      continue
    }
    if (token.startsWith('-')) {
      continue
    }
    positionals.push(token)
  }

  if (['clone', 'fetch', 'ls-remote', 'pull', 'push'].includes(subcommand)) {
    return positionals[0] ?? null
  }
  if (subcommand === 'remote' && positionals[0] === 'add') {
    return positionals[2] ?? null
  }
  if (subcommand === 'submodule' && positionals[0] === 'add') {
    return positionals[1] ?? null
  }
  return null
}

function exactNetworkResources(
  analysis: ShellCapabilityAnalysis,
): Array<Extract<CapabilityResource, { kind: 'network' }>> {
  const resources = new Map<string, Extract<CapabilityResource, { kind: 'network' }>>()
  const shellTokens = tokenizeShell(analysis.command)
  const gitRemote = analysis.segmentHead === 'git' ? gitRemoteOperand(shellTokens) : null
  for (const rawToken of shellTokens) {
    const optionSeparator = rawToken.startsWith('-') ? rawToken.indexOf('=') : -1
    const optionName = optionSeparator === -1 ? null : rawToken.slice(0, optionSeparator)
    const token =
      optionSeparator !== -1 && optionName && NETWORK_VALUE_OPTIONS.has(optionName)
        ? rawToken.slice(optionSeparator + 1)
        : rawToken
    const endpoint = parseNetworkEndpoint(token, {
      allowHostedGitShorthand: PACKAGE_SPEC_COMMANDS.has(analysis.segmentHead),
      allowScpStyle:
        SCP_STYLE_COMMANDS.has(analysis.segmentHead) &&
        (analysis.segmentHead !== 'git' || rawToken === gitRemote),
    })
    if (!endpoint) {
      continue
    }
    const resource = { kind: 'network' as const, ...endpoint }
    resources.set(`${resource.host}:${resource.port ?? ''}:${resource.protocol}`, resource)
  }
  return [...resources.values()]
}

export function buildShellCapabilityRequest(
  analysis: ShellCapabilityAnalysis,
): CapabilityRequestV1 {
  const [request] = buildShellCapabilityRequests(analysis)
  if (!request) {
    throw new Error('shell analysis produced no capability request')
  }
  return request
}

export function buildShellCapabilityRequests(
  analysis: ShellCapabilityAnalysis,
): CapabilityRequestV1[] {
  const resources = isNetworkShellAnalysis(analysis) ? exactNetworkResources(analysis) : []
  const selectedResources = resources.length > 0 ? resources : [resourceForShellAnalysis(analysis)]
  return selectedResources.map((resource) => ({
    version: CAPABILITY_REQUEST_VERSION,
    principal: {
      adapter: analysis.adapter,
      repoRoot: analysis.repoRoot,
      sessionHash: hashSession(`${analysis.repoRoot}:${analysis.cwd}`),
    },
    action: actionForShellAnalysis(analysis),
    resource,
    context: {
      cwd: analysis.cwd,
      inputFingerprint: analysis.inputFingerprint,
      hookKind: analysis.hookKind,
      analysisBasis: [
        `segment:${analysis.segmentHead}`,
        `effect:${analysis.effect}`,
        `location:${analysis.location}`,
        `opacity:${analysis.opacity}`,
      ],
    },
    evidence: {
      level: evidenceLevelForOpacity(analysis.opacity),
      signals: [...analysis.signals],
    },
  }))
}

function actionForFileMutation(analysis: FileMutationCapabilityAnalysis): CapabilityAction {
  if (analysis.locationLabel === 'control_plane') {
    return 'control_plane.write'
  }
  if (analysis.locationLabel === 'sensitive_path') {
    return 'fs.write'
  }
  if (analysis.isDelete) {
    return 'fs.write'
  }
  return 'fs.write'
}

export function buildFileMutationCapabilityRequest(
  analysis: FileMutationCapabilityAnalysis,
): CapabilityRequestV1 {
  return {
    version: CAPABILITY_REQUEST_VERSION,
    principal: {
      adapter: analysis.adapter,
      repoRoot: analysis.repoRoot,
      sessionHash: hashSession(`${analysis.repoRoot}:${analysis.cwd}`),
    },
    action: actionForFileMutation(analysis),
    resource: { kind: 'path', path: analysis.resolvedPath },
    context: {
      cwd: analysis.cwd,
      inputFingerprint: analysis.inputFingerprint,
      hookKind: analysis.hookKind,
      analysisBasis: [
        `tool:${analysis.toolKind}`,
        `location:${analysis.locationLabel}`,
        analysis.isDelete ? 'delete' : 'write',
      ],
    },
    evidence: {
      level: analysis.locationLabel === 'repo_local' ? 'certain' : 'possible',
      signals: [...analysis.signals],
    },
  }
}

function findFreshGrant(
  request: CapabilityRequestV1,
  grants: CapabilityGrantV1[] | undefined,
): CapabilityGrantV1 | null {
  if (!grants?.length) {
    return null
  }
  const now = Date.now()
  for (const grant of grants) {
    const expires = Date.parse(grant.expiresAt)
    if (Number.isFinite(expires) && expires > now && grantMatchesRequest(grant, request)) {
      return grant
    }
  }
  return null
}

function hasFreshGrant(
  request: CapabilityRequestV1,
  grants: CapabilityGrantV1[] | undefined,
): boolean {
  return findFreshGrant(request, grants) !== null
}

function grantDecisionSignals(request: CapabilityRequestV1, grant: CapabilityGrantV1): string[] {
  const signals = [...request.evidence.signals, 'capability_grant']
  if (grant.issuer === BOUNDARY_GRANT_ISSUER_CONTAINER) {
    signals.push('boundary_materialized_grant')
  }
  return signals
}

function shellLocationFromRequest(request: CapabilityRequestV1): string | null {
  const entry = request.context.analysisBasis.find((basis) => basis.startsWith('location:'))
  return entry?.slice('location:'.length) ?? null
}

function isRepoLocalShellLocation(request: CapabilityRequestV1): boolean {
  return shellLocationFromRequest(request) === 'repo_local'
}

function isRepoLocalPackageExec(request: CapabilityRequestV1): boolean {
  if (request.action !== 'process.exec' || request.resource.kind !== 'executable') {
    return false
  }
  if (!request.evidence.signals.includes('package_exec.local_bin_resolved')) {
    return false
  }
  const commandPath = canonicalPath(request.resource.command)
  return path.isAbsolute(commandPath) && pathWithinRoot(request.principal.repoRoot, commandPath)
}

function isRepoLocalRoutineWrite(request: CapabilityRequestV1, sensitivePaths: string[]): boolean {
  if (!isRepoLocalShellLocation(request)) {
    return false
  }
  if (request.action !== 'fs.write' && request.action !== 'fs.read') {
    return false
  }
  if (request.resource.kind !== 'path') {
    return false
  }
  const resolved = resolveCapabilityPath(request.resource.path, request.context.cwd)
  const repoRoot = canonicalPath(request.principal.repoRoot)
  if (!pathWithinRoot(repoRoot, resolved)) {
    return false
  }
  const relative = resolved.slice(repoRoot.length).replace(/^[/\\]/, '')
  return !matchesSensitivePath(relative, sensitivePaths)
}

function isTrustedWorkspaceWrite(
  request: CapabilityRequestV1,
  trustedWorkspaceRoots: string[] | undefined,
): boolean {
  if (!trustedWorkspaceRoots?.length || request.resource.kind !== 'path') {
    return false
  }
  const match = resolveWorkspaceRootMatch(
    request.principal.repoRoot,
    trustedWorkspaceRoots,
    request.resource.path,
  )
  return match?.kind === 'trusted'
}

/**
 * boundary.verified widens only when builtin already allows, or a boundary-materialized
 * grant is present for an approved high-risk action (network via egress chokepoint).
 */
function verifiedBoundaryAllows(
  request: CapabilityRequestV1,
  context: AuthorizationContext,
): boolean {
  if (!boundaryVerifiedAllowEnabled(context.attestation)) {
    return false
  }
  if (request.evidence.level !== 'certain') {
    return false
  }
  const builtin = builtInRule(request, context)
  if (builtin?.outcome === 'allow') {
    return isPathWithinBoundaryMount(request)
  }
  if (builtin?.outcome === 'deny') {
    return false
  }
  return hasFreshGrant(
    request,
    context.grants?.filter((grant) => grant.issuer === BOUNDARY_GRANT_ISSUER_CONTAINER),
  )
}

function builtInRule(
  request: CapabilityRequestV1,
  context: AuthorizationContext,
): PolicyDecision | null {
  const trustedWorkspaceRoots = context.trustedWorkspaceRoots
  const sensitivePaths = context.config.classifier.sensitivePaths
  if (request.action === 'control_plane.write') {
    return {
      outcome: 'require_approval',
      reason: 'control_plane_mutation',
      signals: [...request.evidence.signals, 'control_plane_path'],
      matchedRule: 'builtin.control_plane',
    }
  }

  if (request.action === 'process.exec' && request.context.hookKind === 'subagent') {
    return {
      outcome: 'allow',
      reason: 'subagent_review',
      signals: [...request.evidence.signals],
      matchedRule: 'builtin.subagent',
    }
  }

  if (isRepoLocalPackageExec(request)) {
    return {
      outcome: 'allow',
      reason: 'read_only',
      signals: [...request.evidence.signals, 'repo_local_exec'],
      matchedRule: 'builtin.repo_local_exec',
    }
  }

  if (request.action === 'secret.read' || request.action === 'git.ref.write') {
    return {
      outcome: 'require_approval',
      reason: 'high_stakes_path',
      signals: [...request.evidence.signals, 'secret_path'],
      matchedRule: 'builtin.secret',
    }
  }

  if (request.action === 'network.connect') {
    return {
      outcome: 'require_approval',
      reason: 'external_effect',
      signals: [...request.evidence.signals, 'network_connect'],
      matchedRule: 'builtin.network',
    }
  }

  if (request.action === 'indeterminate' || request.evidence.level === 'indeterminate') {
    return {
      outcome: 'require_approval',
      reason: 'indeterminate_effect',
      signals: [...request.evidence.signals, 'indeterminate'],
      matchedRule: 'builtin.indeterminate',
    }
  }

  if (request.resource.kind === 'path' && sensitivePaths?.length) {
    const repoRoot = canonicalPath(request.principal.repoRoot)
    const resolved = resolveCapabilityPath(request.resource.path, request.context.cwd)
    if (pathWithinRoot(repoRoot, resolved)) {
      const relative = resolved.slice(repoRoot.length).replace(/^[/\\]/, '')
      if (matchesSensitivePath(relative, sensitivePaths)) {
        return {
          outcome: 'require_approval',
          reason: 'high_stakes_path',
          signals: [...request.evidence.signals, 'sensitive_path'],
          matchedRule: 'builtin.sensitive_path',
        }
      }
    }
  }

  if (request.resource.kind === 'path') {
    const repoRoot = canonicalPath(request.principal.repoRoot)
    const resolved = resolveCapabilityPath(request.resource.path, request.context.cwd)
    const insideRepo = pathWithinRoot(repoRoot, resolved)
    if (!insideRepo && !isTrustedWorkspaceWrite(request, trustedWorkspaceRoots)) {
      return {
        outcome: 'require_approval',
        reason: 'outside_repo_mutation',
        signals: [...request.evidence.signals, 'outside_repo_path'],
        matchedRule: 'builtin.outside_repo',
      }
    }
  }

  if (request.action === 'fs.read' || request.action === 'fs.write') {
    if (
      request.action === 'fs.read' &&
      request.resource.kind === 'executable' &&
      isRepoLocalShellLocation(request)
    ) {
      return {
        outcome: 'allow',
        reason: 'read_only',
        signals: [...request.evidence.signals],
        matchedRule: 'builtin.repo_local',
      }
    }
    if (isRepoLocalRoutineWrite(request, sensitivePaths)) {
      return {
        outcome: 'allow',
        reason: request.action === 'fs.read' ? 'read_only' : 'repo_local_mutation',
        signals: [...request.evidence.signals],
        matchedRule: 'builtin.repo_local',
      }
    }
    if (isTrustedWorkspaceWrite(request, trustedWorkspaceRoots)) {
      return {
        outcome: 'allow',
        reason: 'trusted_workspace_root',
        signals: [...request.evidence.signals, 'trusted_workspace_root'],
        matchedRule: 'builtin.trusted_workspace',
      }
    }
  }

  if (request.evidence.signals.includes('unparseable_shell')) {
    const deny = context.config.policy.unparseableShell === 'deny'
    return {
      outcome: deny ? 'require_approval' : 'allow',
      reason: 'unparseable_shell',
      signals: [...request.evidence.signals],
      matchedRule: deny ? 'builtin.unparseable' : 'builtin.unparseable_allow_flagged',
    }
  }

  if (request.evidence.signals.includes('opaque_execution')) {
    return {
      outcome: 'require_approval',
      reason: 'opaque_execution',
      signals: [...request.evidence.signals],
      matchedRule: 'builtin.opaque',
    }
  }

  return null
}

export function createTypeScriptPolicyEngine(): PolicyEngine {
  return {
    evaluate(request, context): PolicyDecision {
      if (request.evidence.signals.includes('forged_grant')) {
        return {
          outcome: 'deny',
          reason: 'grant_forgery',
          signals: [...request.evidence.signals, 'grant_forgery'],
          matchedRule: 'forbid.grant_forgery',
        }
      }

      const grants = context.grants
      if (
        grants?.some(
          (grant) => isGrantScopeTooBroad(grant) && broadGrantTargetsRequest(grant, request),
        )
      ) {
        return {
          outcome: 'deny',
          reason: 'grant_scope_too_broad',
          signals: [...request.evidence.signals, 'grant_scope_too_broad'],
          matchedRule: 'forbid.broad_grant',
        }
      }

      const matchedGrant = findFreshGrant(request, grants)
      if (matchedGrant) {
        return {
          outcome: 'allow',
          reason: 'capability_grant',
          signals: grantDecisionSignals(request, matchedGrant),
          matchedRule: 'grant.exact',
        }
      }

      if (verifiedBoundaryAllows(request, context)) {
        return {
          outcome: 'allow',
          reason: 'verified_boundary',
          signals: [...request.evidence.signals, 'verified_boundary'],
          matchedRule: 'boundary.verified',
        }
      }

      const builtin = builtInRule(request, context)
      if (builtin) {
        return builtin
      }

      return {
        outcome: 'require_approval',
        reason: 'policy_default',
        signals: [...request.evidence.signals, 'default_deny'],
        matchedRule: 'default.require_approval',
      }
    },
  }
}

let defaultPolicyEngine: PolicyEngine | null = null

export function getDefaultPolicyEngine(): PolicyEngine {
  if (!defaultPolicyEngine) {
    defaultPolicyEngine = createTypeScriptPolicyEngine()
  }
  return defaultPolicyEngine
}

export function policyDecisionRequiresAsk(decision: PolicyDecision): boolean {
  return decision.outcome === 'require_approval' || decision.outcome === 'deny'
}

function policyOutcomeRank(outcome: PolicyDecision['outcome']): number {
  switch (outcome) {
    case 'deny':
      return 3
    case 'require_approval':
      return 2
    case 'allow':
      return 1
    default:
      return 0
  }
}

export function combinePolicyDecisions(decisions: readonly PolicyDecision[]): PolicyDecision {
  if (!decisions.length) {
    return {
      outcome: 'allow',
      reason: 'read_only',
      signals: [],
      matchedRule: 'plan.conjunction',
    }
  }
  const sorted = [...decisions].sort(
    (left, right) => policyOutcomeRank(right.outcome) - policyOutcomeRank(left.outcome),
  )
  const worst = sorted[0]
  if (!worst) {
    return {
      outcome: 'allow',
      reason: 'read_only',
      signals: [],
      matchedRule: 'plan.conjunction',
    }
  }
  return worst
}

export function evaluateCapabilityRequestsPolicy(
  requests: readonly CapabilityRequestV1[],
  config: BelayConfigV4,
  auth?: PolicyAuthExtras,
  trustedWorkspaceRoots?: string[],
): { decisions: PolicyDecision[]; decision: PolicyDecision } {
  let workingAuth = auth
  const decisions: PolicyDecision[] = []
  for (const request of requests) {
    const enriched = enrichAuthWithMaterializedGrants(request, config, workingAuth)
    const decision = getDefaultPolicyEngine().evaluate(
      request,
      buildAuthorizationContext(config, trustedWorkspaceRoots, enriched),
    )
    decisions.push(decision)
    const previousCount = workingAuth?.grants?.length ?? 0
    const nextCount = enriched?.grants?.length ?? 0
    if (nextCount > previousCount) {
      workingAuth = enriched
    }
  }
  return {
    decisions,
    decision: combinePolicyDecisions(decisions),
  }
}

export function evaluateShellPolicy(
  analysis: ShellCapabilityAnalysis,
  config: BelayConfigV4,
  auth?: PolicyAuthExtras,
): { request: CapabilityRequestV1; requests: CapabilityRequestV1[]; decision: PolicyDecision } {
  const requests = buildShellCapabilityRequests(analysis)
  const enrichedAuth = {
    ...auth,
    sensitivePaths: auth?.sensitivePaths ?? analysis.sensitivePaths,
  }
  const { decision } = evaluateCapabilityRequestsPolicy(
    requests,
    config,
    enrichedAuth,
    analysis.trustedWorkspaceRoots,
  )
  const [request] = requests
  if (!request) {
    throw new Error('shell analysis produced no capability request')
  }
  return { request, requests, decision }
}

export function evaluateFileMutationPolicy(
  analysis: FileMutationCapabilityAnalysis,
  config: BelayConfigV4,
  auth?: PolicyAuthExtras,
): { request: CapabilityRequestV1; decision: PolicyDecision } {
  const request = buildFileMutationCapabilityRequest(analysis)
  const enriched = enrichAuthWithMaterializedGrants(request, config, {
    ...auth,
    sensitivePaths: auth?.sensitivePaths ?? analysis.sensitivePaths,
  })
  const decision = getDefaultPolicyEngine().evaluate(
    request,
    buildAuthorizationContext(config, analysis.trustedWorkspaceRoots, enriched),
  )
  return { request, decision }
}
