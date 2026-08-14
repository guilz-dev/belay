import type {
  CapabilityAction,
  CapabilityEvidenceLevel,
  CapabilityResource,
} from '../capability/request.js'
import type { VerdictOpacity } from '../verdict/types.js'

export const EFFECT_PLAN_VERSION = 1 as const

export type EffectTag =
  | 'fs.read'
  | 'fs.write'
  | 'process.exec'
  | 'network.connect'
  | 'network.acquire'
  | 'git.ref.write'
  | 'secret.read'
  | 'control_plane.write'
  | 'read_only'
  | 'indeterminate'

export type LauncherPhase =
  | 'invoke'
  | 'resolve'
  | 'acquire'
  | 'cache_read'
  | 'cache_write'
  | 'delegate'

export type PackageExecLauncher = 'npx' | 'npm' | 'pnpm'

export type EffectPlanDisposition = 'effects' | 'effect_free'

export type AnalysisCompleteness = 'complete' | 'partial'

export interface EffectPlanPolicyProjection {
  permission: 'allow' | 'ask'
  hookVerdict: 'allow' | 'allow_flagged' | 'deny_pending_approval'
  reason: string
}

export interface EffectEvidence {
  level: CapabilityEvidenceLevel
  signals: readonly string[]
  basis: readonly string[]
}

export interface EffectProvenance {
  segment?: string
  launcher?: PackageExecLauncher
  phase?: LauncherPhase
  innerCommand?: string
  innerArgv?: readonly string[]
}

export interface EffectRequirement {
  tag: EffectTag
  action: CapabilityAction
  resource: CapabilityResource
  evidence: EffectEvidence
  provenance: EffectProvenance
  /** All contributing sources after requirement de-duplication. */
  provenances?: readonly EffectProvenance[]
}

export interface ExecEffectNode {
  kind: 'exec'
  commandRedacted: string
  segmentHead: string
  requirements: readonly EffectRequirement[]
}

export interface LauncherEffectNode {
  kind: 'launcher'
  launcher: PackageExecLauncher | 'npm' | 'pnpm' | 'make'
  phase: LauncherPhase
  opaque: boolean
  reason: string
  children: readonly EffectNode[]
}

export interface MergeEffectNode {
  kind: 'merge'
  children: readonly EffectNode[]
}

export type EffectNode = ExecEffectNode | LauncherEffectNode | MergeEffectNode

export interface EffectPlan {
  version: typeof EFFECT_PLAN_VERSION
  root: EffectNode
  inputFingerprint: string
  opacity: VerdictOpacity
  disposition: EffectPlanDisposition
  completeness: AnalysisCompleteness
  signals: readonly string[]
}
