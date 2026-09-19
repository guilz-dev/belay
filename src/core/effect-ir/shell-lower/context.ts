import type {
  EffectManifestApplicationRole,
  EffectManifestAuditV1,
  EffectManifestFrontendId,
} from '../../effect-manifest/types.js'
import type { ShellFrontendMode } from '../../shell-frontend/types.js'

export interface LowerShellEffectPlanParams {
  command: string
  cwd: string
  repoRoot: string
  inputFingerprint: string
  env?: Readonly<Record<string, string | undefined>>
  /** Absent means the historical legacy frontend. */
  shellFrontendMode?: ShellFrontendMode
  /** Per-frontend manifest authority; default canonical. */
  effectManifestRole?: EffectManifestApplicationRole
  effectManifestFrontendId?: EffectManifestFrontendId
  effectManifestGateConsumptionEnabled?: boolean
}

export interface LowerContext extends LowerShellEffectPlanParams {
  depth: number
  effectManifestAudits?: EffectManifestAuditV1[]
}
