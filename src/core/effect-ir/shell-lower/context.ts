import type { BelayConfigV3 } from '../../config.js'
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
  /** Repo belay config; required for manifest trust resolution at gate time. */
  belayConfig?: BelayConfigV3
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
