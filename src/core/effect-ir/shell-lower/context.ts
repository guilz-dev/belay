import type { ShellFrontendMode } from '../../shell-frontend/types.js'

export interface LowerShellEffectPlanParams {
  command: string
  cwd: string
  repoRoot: string
  inputFingerprint: string
  env?: Readonly<Record<string, string | undefined>>
  /** Absent means the historical legacy frontend. */
  shellFrontendMode?: ShellFrontendMode
}

export interface LowerContext extends LowerShellEffectPlanParams {
  depth: number
}
