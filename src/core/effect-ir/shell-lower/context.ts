export interface LowerShellEffectPlanParams {
  command: string
  cwd: string
  repoRoot: string
  inputFingerprint: string
  env?: Readonly<Record<string, string | undefined>>
}

export interface LowerContext extends LowerShellEffectPlanParams {
  depth: number
}
