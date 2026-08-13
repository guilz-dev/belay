import { collectRequirements } from '../effect-ir/build.js'
import { evaluateEffectPlanPolicy } from '../effect-ir/policy.js'
import { lowerShellEffectPlan } from '../effect-ir/shell-lower.js'
import type { EffectRequirement } from '../effect-ir/types.js'
import { canonicalPath, pathWithinRoot } from '../path-utils.js'
import { cwdRelative } from './containment.js'
import { verdictFingerprint } from './fingerprint.js'
import { redactCommand } from './parser.js'
import type { VerdictContext, VerdictEffect, VerdictLocation, VerdictResult } from './types.js'

export async function verdict(command: string, context: VerdictContext): Promise<VerdictResult> {
  const trimmed = command.trim()
  const commandRedacted = redactCommand(trimmed)
  const fingerprint = verdictFingerprint(
    cwdRelative(context.repoRoot, context.cwd),
    commandRedacted,
  )
  const effectPlan = lowerShellEffectPlan({
    command: trimmed,
    cwd: context.cwd,
    repoRoot: context.repoRoot,
    inputFingerprint: fingerprint,
  })
  const policy = evaluateEffectPlanPolicy(effectPlan, context)
  const requirements = collectRequirements(effectPlan.root)
  const presentation = effectPresentation(requirements, context)
  const policySignals = [
    ...new Set([...effectPlan.signals, ...policy.authorizationDecision.signals]),
  ]
  const reason =
    policySignals.includes('tier0_external') && policy.projection.permission === 'ask'
      ? 'tier0_external'
      : policySignals.includes('rsync_destructive') && policy.projection.permission === 'ask'
        ? 'rsync_destructive'
        : policy.authorizationDecision.matchedRule === 'grant.exact' &&
            (presentation.location === 'repo_outside' || presentation.location === 'mixed') &&
            presentation.effect === 'local_mutation'
          ? 'repo_outside_local_mutation'
          : policySignals.includes('shell.cwd_unknown') && policy.projection.permission === 'ask'
            ? 'missing_trusted_cwd'
            : policy.projection.reason
  const location = policySignals.includes('shell.cwd_unknown') ? 'unknown' : presentation.location

  return {
    permission: policy.projection.permission,
    location,
    opacity: effectPlan.opacity,
    effect: presentation.effect,
    confidence: 'deterministic',
    reason: trimmed ? reason : 'empty_command',
    commandRedacted,
    fingerprint,
    signals: [...new Set([...(trimmed ? [] : ['empty_command']), ...policySignals])],
    capabilityRequests: policy.capabilityRequests,
    authorizationDecision: policy.authorizationDecision,
    effectPlan,
    effectPlanPolicyDecisions: policy.decisions,
    effectPlanProjection: policy.projection,
  }
}

const EFFECT_LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '0:0:0:0:0:0:0:1'])

function effectPresentation(
  requirements: readonly EffectRequirement[],
  context: VerdictContext,
): { location: VerdictLocation; effect: VerdictEffect } {
  let local = false
  let outside = false
  let remote = false
  let mutation = false
  let unknown = false
  const repoRoot = canonicalPath(context.repoRoot)

  for (const requirement of requirements) {
    if (requirement.action === 'indeterminate') {
      unknown = true
      continue
    }
    if (requirement.resource.kind === 'path') {
      const resolved = canonicalPath(requirement.resource.path)
      if (pathWithinRoot(repoRoot, resolved)) {
        local = true
      } else {
        outside = true
      }
    } else if (requirement.resource.kind === 'network') {
      const host = requirement.resource.host.replace(/^\[|\]$/g, '').toLowerCase()
      if (EFFECT_LOOPBACK_HOSTS.has(host)) {
        local = true
      } else {
        remote = true
      }
    } else {
      local = true
    }

    if (
      requirement.action === 'fs.write' ||
      requirement.action === 'git.ref.write' ||
      requirement.action === 'control_plane.write' ||
      (requirement.action === 'process.exec' &&
        requirement.resource.kind === 'executable' &&
        requirement.resource.operation === 'spawn') ||
      (requirement.action === 'network.connect' &&
        requirement.resource.kind === 'network' &&
        requirement.resource.mode === 'mutate')
    ) {
      mutation = true
    }
  }

  const location: VerdictLocation =
    remote && (local || outside)
      ? 'mixed'
      : remote
        ? 'external'
        : outside && local
          ? 'mixed'
          : outside
            ? 'repo_outside'
            : local || requirements.length === 0
              ? 'repo_local'
              : 'unknown'
  const effect: VerdictEffect =
    remote && mutation
      ? 'remote_mutation'
      : mutation
        ? 'local_mutation'
        : unknown
          ? 'unknown'
          : 'read_only'
  return { location, effect }
}
