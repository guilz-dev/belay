export type VerdictPermission = 'allow' | 'ask'

export type VerdictLocation = 'repo_local' | 'repo_outside' | 'external' | 'mixed' | 'unknown'

export type VerdictOpacity = 'transparent' | 'recursive' | 'opaque' | 'unparseable'

export type VerdictEffect = 'read_only' | 'local_mutation' | 'remote_mutation' | 'unknown'

export type VerdictConfidence =
  | 'deterministic'
  | 'llm'
  | 'assumed_repo_local'
  | 'verified_substrate'

export interface VerdictResult {
  permission: VerdictPermission
  location: VerdictLocation
  opacity: VerdictOpacity
  effect: VerdictEffect
  confidence: VerdictConfidence
  reason: string
  commandRedacted: string
  fingerprint: string
  signals: string[]
  judgeTrace?: JudgeTrace
}

export interface Tier1Verdict {
  /** true = undoable via git/fs snapshot or trivial local revert (ADR-002 local-recoverable). */
  local_recoverable: boolean
  destroys_history_or_secrets: boolean
  reason: string
  /** @deprecated Legacy LLM field; parsed only for migration. */
  external_change?: boolean
  /** @deprecated Unused in decision logic. */
  destroys_outside_repo?: boolean
}

export interface Tier1EvaluateInput {
  text: string
  context: { cwd: string; repoRoot: string }
  innerCode?: string
}

export interface Tier1Judge {
  evaluate(input: Tier1EvaluateInput): Promise<Tier1Verdict>
}

export interface JudgeTrace {
  provider: 'openai-compatible' | 'ollama' | 'fallback'
  modelRequested: string
  modelResolved: string
  latencyMs: number
  outboundRedacted?: boolean
  fallbackReason?: string
}

export type VerdictMode = 'enforce' | 'audit'

export interface VerdictContext {
  cwd: string
  repoRoot: string
  trustedCwd: boolean
  trustedWorkspaceRoots?: string[]
  sensitivePaths: string[]
  protectedArtifactRoots?: string[]
  customAllowCommands?: string[]
  customExternalCommands?: string[]
  judge: Tier1Judge
  mode: VerdictMode
  unknownLocalEffect: 'allow_flagged' | 'deny'
  unparseableShell: 'allow_flagged' | 'deny'
  maxRecursionDepth?: number
}

export interface InternalSegmentVerdict {
  permission: VerdictPermission
  location: VerdictLocation
  opacity: VerdictOpacity
  effect: VerdictEffect
  confidence: VerdictConfidence
  reason: string
  signals: string[]
  judgeTrace?: JudgeTrace
}
