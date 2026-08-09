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
          {
            tag: level === 'indeterminate' ? 'indeterminate' : 'network.acquire',
            action: level === 'indeterminate' ? 'indeterminate' : 'network.connect',
            resource:
              level === 'indeterminate'
                ? { kind: 'unknown' }
                : { kind: 'network', host: 'registry.npmjs.org', protocol: 'registry' },
            evidence: {
              level,
              signals: [...peel.signals, 'package_acquire_possible'],
              basis: [`launcher:${peel.launcher}:acquire`],
            },
            provenance: { launcher: peel.launcher, phase: 'acquire' },
          },
          ...(level === 'possible' ? [cacheWriteRequirement(peel)] : []),
        ],
      },
    ],
  }
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
    signals,
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
