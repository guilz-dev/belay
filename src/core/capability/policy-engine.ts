import { createHash } from 'node:crypto'
import path from 'node:path'

import type { BelayConfigV4 } from '../config.js'
import { matchesSensitivePath } from '../glob.js'
import { canonicalPath, pathWithinRoot, resolveWorkspaceRootMatch } from '../path-utils.js'
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
  if (analysis.effect === 'local_mutation') {
    const outside = resolved.find((candidate) => !pathWithinRoot(repoRoot, candidate))
    return outside ?? resolved[resolved.length - 1]!
  }
  return resolved[0]!
}

function resourceForShellAnalysis(analysis: ShellCapabilityAnalysis): CapabilityResource {
  if (isGitRefWrite(analysis)) {
    return { kind: 'git-ref', ref: 'push' }
  }
  if (
    analysis.egressClass === 'ambiguous' ||
    analysis.egressClass === 'read' ||
    analysis.egressClass === 'destructive' ||
    analysis.location === 'external'
  ) {
    return { kind: 'network', host: '*', protocol: 'unknown' }
  }
  const resourcePath = resourcePathForShellAnalysis(analysis)
  if (resourcePath) {
    return { kind: 'path', path: resourcePath }
  }
  return { kind: 'executable', command: analysis.segmentHead }
}

export function buildShellCapabilityRequest(
  analysis: ShellCapabilityAnalysis,
): CapabilityRequestV1 {
  return {
    version: CAPABILITY_REQUEST_VERSION,
    principal: {
      adapter: analysis.adapter,
      repoRoot: analysis.repoRoot,
      sessionHash: hashSession(`${analysis.repoRoot}:${analysis.cwd}`),
    },
    action: actionForShellAnalysis(analysis),
    resource: resourceForShellAnalysis(analysis),
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
  }
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

export function evaluateShellPolicy(
  analysis: ShellCapabilityAnalysis,
  config: BelayConfigV4,
  auth?: PolicyAuthExtras,
): { request: CapabilityRequestV1; decision: PolicyDecision } {
  const request = buildShellCapabilityRequest(analysis)
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
