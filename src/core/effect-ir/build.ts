import type { CapabilityPrincipal, CapabilityRequestV1 } from '../capability/request.js'
import type { LauncherResolution } from '../verdict/launcher-resolve.js'
import { mergeRequirements } from './normalize.js'
import {
  innerRecipeFromPeel,
  type PackageExecPeelResult,
  peelPackageExecArgv,
  resolveLocalBin,
} from './package-exec.js'
import type {
  EffectNode,
  EffectPlan,
  EffectRequirement,
  LauncherEffectNode,
  PackageExecLauncher,
} from './types.js'

export interface BuildEffectPlanParams {
  tokens: string[]
  cwd: string
  repoRoot: string
  inputFingerprint: string
  launcherResolution?: LauncherResolution | null
  innerRequirements?: readonly EffectRequirement[]
}

export interface BuildCapabilityEffectPlanParams {
  actionKind: 'shell' | 'tool' | 'subagent'
  summary: string
  inputFingerprint: string
  requests: readonly CapabilityRequestV1[]
  effectFree: boolean
}

export function buildPackageExecEffectNode(params: BuildEffectPlanParams): EffectNode | null {
  const peel = peelPackageExecArgv(params.tokens)
  if (!peel) {
    return null
  }
  const children: EffectNode[] = []
  const invokeNode: LauncherEffectNode = {
    kind: 'launcher',
    launcher: peel.launcher,
    phase: 'invoke',
    opaque: peel.opaque,
    reason: peel.reason,
    children: [],
  }
  children.push(invokeNode)

  if (peel.opaque) {
    children.push(acquireRequirement(peel, 'indeterminate'))
    return { kind: 'merge', children }
  }
  if (peel.reason === 'npx_wrapper_readonly') {
    return { kind: 'merge', children }
  }

  const innerRecipe = innerRecipeFromPeel(peel)
  const binHead = peel.innerTokens[0] ?? ''
  const local = !peel.forceAcquire ? resolveLocalBin(binHead, params.cwd, params.repoRoot) : null

  if (local) {
    children.push({
      kind: 'launcher',
      launcher: peel.launcher,
      phase: 'resolve',
      opaque: false,
      reason: 'npx_local_bin_resolved',
      children: [],
    })
    if (innerRecipe) {
      children.push(delegateExecNode(peel, innerRecipe, binHead, local.path))
    }
    if (innerRecipe && params.innerRequirements !== undefined) {
      if (params.innerRequirements.length > 0) {
        children.push({
          kind: 'exec',
          commandRedacted: innerRecipe,
          segmentHead: binHead,
          requirements: [...params.innerRequirements],
        })
      }
    }
  } else {
    children.push(acquireRequirement(peel, 'possible'))
    if (innerRecipe) {
      children.push(delegateExecNode(peel, innerRecipe, binHead))
    }
  }

  return { kind: 'merge', children }
}

function delegateExecNode(
  peel: PackageExecPeelResult,
  innerRecipe: string,
  segmentHead: string,
  resolvedLocalPath?: string,
): EffectNode {
  return {
    kind: 'launcher',
    launcher: peel.launcher,
    phase: 'delegate',
    opaque: false,
    reason: 'package_exec_delegate',
    children: [
      {
        kind: 'exec',
        commandRedacted: innerRecipe,
        segmentHead,
        requirements: [
          {
            tag: 'process.exec',
            action: 'process.exec',
            resource: { kind: 'executable', command: resolvedLocalPath ?? segmentHead },
            evidence: {
              level: resolvedLocalPath ? 'certain' : peel.forceAcquire ? 'possible' : 'certain',
              signals: [
                'package_exec.delegate',
                ...(resolvedLocalPath ? ['package_exec.local_bin_resolved'] : []),
              ],
              basis: [`launcher:${peel.launcher}`],
            },
            provenance: {
              launcher: peel.launcher,
              phase: 'delegate',
              innerCommand: innerRecipe,
              innerArgv: [...peel.innerTokens],
            },
          },
        ],
      },
    ],
  }
}

function cacheWriteRequirement(peel: PackageExecPeelResult): EffectRequirement {
  return {
    tag: 'fs.write',
    action: 'fs.write',
    resource: { kind: 'package-cache', manager: peel.launcher === 'pnpm' ? 'pnpm' : 'npm' },
    evidence: {
      level: 'possible',
      signals: [...peel.signals, 'package_cache_write'],
      basis: [`launcher:${peel.launcher}:cache_write`],
    },
    provenance: { launcher: peel.launcher, phase: 'cache_write' },
  }
}

function acquireRequirement(
  peel: PackageExecPeelResult,
  level: 'possible' | 'indeterminate',
): LauncherEffectNode {
  const knownResources = packageAcquisitionResources(peel.acquisitionSpecs)
  const networkRequirements: EffectRequirement[] = knownResources.map((resource) =>
    acquireNetworkRequirement(peel, resource, 'possible'),
  )
  if (level === 'indeterminate') {
    networkRequirements.push(acquireNetworkRequirement(peel, { kind: 'unknown' }, level))
  } else if (networkRequirements.length === 0 && peel.acquisitionSpecs.length === 0) {
    networkRequirements.push(
      acquireNetworkRequirement(
        peel,
        { kind: 'network', host: 'registry.npmjs.org', protocol: 'registry' },
        level,
      ),
    )
  }
  return {
    kind: 'launcher',
    launcher: peel.launcher,
    phase: 'acquire',
    opaque: level === 'indeterminate',
    reason: peel.reason,
    children: [
      {
        kind: 'exec',
        commandRedacted: peel.innerTokens.join(' ') || peel.launcher,
        segmentHead: peel.launcher,
        requirements: [
          ...networkRequirements,
          ...(level === 'possible' || peel.acquisitionSpecs.length > 0
            ? [cacheWriteRequirement(peel)]
            : []),
        ],
      },
    ],
  }
}

function acquireNetworkRequirement(
  peel: PackageExecPeelResult,
  resource: EffectRequirement['resource'],
  level: 'possible' | 'indeterminate',
): EffectRequirement {
  return {
    tag: level === 'indeterminate' ? 'indeterminate' : 'network.acquire',
    action: level === 'indeterminate' ? 'indeterminate' : 'network.connect',
    resource,
    evidence: {
      level,
      signals: [...peel.signals, 'package_acquire_possible'],
      basis: [`launcher:${peel.launcher}:acquire`],
    },
    provenance: {
      launcher: peel.launcher,
      phase: 'acquire',
      innerArgv: [...peel.acquisitionSpecs],
    },
  }
}

function packageAcquisitionResources(
  specs: readonly string[],
): Array<Extract<EffectRequirement['resource'], { kind: 'network' }>> {
  const resources = new Map<string, Extract<EffectRequirement['resource'], { kind: 'network' }>>()
  for (const spec of specs) {
    const resource = explicitPackageSource(spec) ?? registrySourceForPackageSpec(spec)
    if (resource) {
      resources.set(`${resource.host}:${resource.port ?? ''}:${resource.protocol ?? ''}`, resource)
    }
  }
  return [...resources.values()]
}

function explicitPackageSource(
  spec: string,
): Extract<EffectRequirement['resource'], { kind: 'network' }> | null {
  const trimmed = spec.trim()
  const normalized = trimmed.startsWith('git+') ? trimmed.slice(4) : trimmed
  if (normalized.startsWith('github:')) {
    return { kind: 'network', host: 'github.com', protocol: 'git' }
  }
  if (normalized.startsWith('gitlab:')) {
    return { kind: 'network', host: 'gitlab.com', protocol: 'git' }
  }
  if (normalized.startsWith('bitbucket:')) {
    return { kind: 'network', host: 'bitbucket.org', protocol: 'git' }
  }
  if (/^[A-Za-z0-9][A-Za-z0-9._-]*\/[^/]+(?:#.*)?$/.test(normalized)) {
    return { kind: 'network', host: 'github.com', protocol: 'git' }
  }
  const scpStyle = normalized.match(/^(?:[^@/]+@)?([^:/]+):[^/].+$/)
  if (scpStyle?.[1]?.includes('.')) {
    return { kind: 'network', host: scpStyle[1], protocol: 'ssh' }
  }
  try {
    const url = new URL(normalized)
    if (!['http:', 'https:', 'ssh:', 'git:'].includes(url.protocol)) {
      return null
    }
    return {
      kind: 'network',
      host: url.hostname,
      ...(url.port ? { port: Number(url.port) } : {}),
      protocol: url.protocol.slice(0, -1),
    }
  } catch {
    return null
  }
}

function registrySourceForPackageSpec(
  spec: string,
): Extract<EffectRequirement['resource'], { kind: 'network' }> | null {
  const normalized = spec.trim()
  if (
    normalized.startsWith('file:') ||
    normalized.startsWith('git+file:') ||
    normalized.startsWith('link:') ||
    normalized.startsWith('workspace:') ||
    normalized.startsWith('./') ||
    normalized.startsWith('../') ||
    normalized.startsWith('/')
  ) {
    return null
  }
  return { kind: 'network', host: 'registry.npmjs.org', protocol: 'registry' }
}

export function collectRequirements(node: EffectNode): EffectRequirement[] {
  switch (node.kind) {
    case 'exec':
      return [...node.requirements]
    case 'launcher':
      return node.children.flatMap((child) => collectRequirements(child))
    case 'merge':
      return mergeRequirements(...node.children.map((child) => collectRequirements(child)))
    default:
      return []
  }
}

export function buildEffectPlan(params: BuildEffectPlanParams): EffectPlan | null {
  const root = buildPackageExecEffectNode(params)
  if (!root) {
    return null
  }
  const requirements = collectRequirements(root)
  const signals = [
    ...new Set([
      ...(params.launcherResolution?.reason ? [params.launcherResolution.reason] : []),
      ...requirements.flatMap((r) => r.evidence.signals),
    ]),
  ]
  const opacity =
    peelPackageExecArgv(params.tokens)?.opaque || params.launcherResolution?.opaque
      ? 'opaque'
      : 'recursive'
  return {
    version: 1,
    root,
    inputFingerprint: params.inputFingerprint,
    opacity,
    disposition: requirements.length > 0 ? 'effects' : 'effect_free',
    completeness: opacity === 'recursive' ? 'complete' : 'partial',
    signals,
  }
}

function effectTagForAction(action: CapabilityRequestV1['action']): EffectRequirement['tag'] {
  return action === 'indeterminate' ? 'indeterminate' : action
}

/** Build the canonical plan envelope for non-package-exec gated actions. */
export function buildCapabilityEffectPlan(params: BuildCapabilityEffectPlanParams): EffectPlan {
  const provenance = { segment: params.actionKind }
  const requirements: EffectRequirement[] = params.requests.map((request) => ({
    tag: effectTagForAction(request.action),
    action: request.action,
    resource: request.resource,
    evidence: {
      level: request.evidence.level,
      signals: [...request.evidence.signals],
      basis: [...request.context.analysisBasis],
    },
    provenance,
    provenances: [provenance],
  }))

  if (!params.effectFree && requirements.length === 0) {
    requirements.push({
      tag: 'indeterminate',
      action: 'indeterminate',
      resource: { kind: 'unknown' },
      evidence: {
        level: 'indeterminate',
        signals: ['effect_plan.incomplete'],
        basis: [`gated_action:${params.actionKind}`],
      },
      provenance,
      provenances: [provenance],
    })
  }

  const partial = requirements.some((requirement) => requirement.evidence.level === 'indeterminate')
  return {
    version: 1,
    root: {
      kind: 'exec',
      commandRedacted: params.summary,
      segmentHead: params.actionKind,
      requirements,
    },
    inputFingerprint: params.inputFingerprint,
    opacity: partial ? 'opaque' : 'transparent',
    disposition: params.effectFree ? 'effect_free' : 'effects',
    completeness: partial ? 'partial' : 'complete',
    signals: [...new Set(requirements.flatMap((requirement) => requirement.evidence.signals))],
  }
}

export function flattenRequirementsToCapabilityRequests(
  requirements: readonly EffectRequirement[],
  opts: {
    principal: CapabilityPrincipal
    cwd: string
    repoRoot: string
    hookKind: 'shell'
    inputFingerprint: string
  },
): CapabilityRequestV1[] {
  return requirements.map((req) => ({
    version: 1 as const,
    principal: opts.principal,
    action: req.action,
    resource: req.resource,
    context: {
      hookKind: opts.hookKind,
      cwd: opts.cwd,
      inputFingerprint: opts.inputFingerprint,
      analysisBasis: [...req.evidence.basis],
    },
    evidence: {
      level: req.evidence.level,
      signals: [...req.evidence.signals],
    },
  }))
}

export type { PackageExecLauncher }
