export type {
  BelayConfig,
  BelayConfigV1,
  BelayConfigV2,
  BelayConfigV3,
  BelayControlPlaneConfig,
  BelayEgressConfig,
  BelayMode,
  BelayOverridesConfig,
  BelayPolicyConfig,
  BelayRedactionConfig,
  BelaySandboxConfig,
  BelayTransactionalConfig,
  UnknownLocalEffectPolicy,
} from './core/config.js'
export type {
  ApprovalRecord,
  ApprovalStateFile,
  Assessment,
  ClassifyResult,
  HookVerdict,
} from './core/types.js'

import type { InstallScope } from './adapters/layouts/scope.js'
import type {
  BelayEgressConfig,
  BelayOverridesConfig,
  BelayPolicyConfig,
  BelaySandboxConfig,
} from './core/config.js'
import type { ApprovalRecord, ClassifyResult } from './core/types.js'

export interface HookEntry {
  command: string
  matcher?: string
}

export interface HooksFile {
  version: number
  hooks: Record<string, HookEntry[]>
}

export type AdapterName = 'cursor' | 'claude' | 'codex'

export interface InitOptions {
  targetDir?: string
  withSkill?: boolean
  dogfood?: boolean
  adapter?: AdapterName
  scope?: InstallScope
  preset?: import('./presets.js').ConfigPresetName
  judgeProfile?: 'local-ollama'
  judgeProvider?: 'ollama' | 'openai-compatible' | 'cursor'
  judgeModel?: string
  judgeEndpoint?: string
  /** Acknowledge cloud judge egress + redaction limits (R19). Required for openai-compatible provider. */
  acceptCloudJudge?: boolean
  /** When true, skip writing judge config (used when user declines cloud consent). */
  skipJudgeWrite?: boolean
}

export interface UpgradeOptions {
  targetDir?: string
  withSkill?: boolean
  adapter?: AdapterName
  scope?: InstallScope
}

export interface DoctorOptions {
  targetDir?: string
  fix?: boolean
  dryRun?: boolean
  adapter?: AdapterName
}

export interface DogfoodStatus {
  active: boolean
  mode: string
  unknownLocalEffect: string
  readyForEnforce: boolean
  gateEvents: number
  wouldBlockCount: number
  wouldBlockRate: number
  notes: string[]
}

export interface ConfigProvenanceNote {
  path: string
  source: 'builtin' | 'team' | 'repo' | 'protected'
}

export interface DoctorReport {
  ok: boolean
  repoRoot: string
  configPath: string
  hooksPath: string
  nodeResolution: {
    ok: boolean
    detail: string
    path?: string
  }
  issues: string[]
  notes: string[]
  warnings: string[]
  configProvenance: ConfigProvenanceNote[]
  dogfood: DogfoodStatus | null
}

export interface StatusOptions {
  targetDir?: string
  json?: boolean
}

export interface HealthSnapshotOptions {
  targetDir?: string
  adapter?: AdapterName
}

export interface HealthSnapshot {
  repoRoot: string
  adapter: AdapterName
  installScope: 'project' | 'global'
  configPath: string
  hooksPath: string
  skillPath: string
  commandsPath?: string
  configPresent: boolean
  hooksInstalled: boolean
  managedHooksOk: boolean
  runtimePresent: boolean
  skillInstalled: boolean
  skillOnly: boolean
  commandsInstalled: boolean
  floorInstalled: boolean
  missingArtifacts: string[]
  judgeIssues: string[]
  judgeWarnings: string[]
  judgeNotes: string[]
}

export interface ClassifyForReportResult {
  repoRoot: string
  kind: ExplainKind
  input: string
  cwd: string
  config: import('./core/config.js').BelayConfigV3
  policy: BelayPolicyConfig
  overrides: BelayOverridesConfig
  egress: BelayEgressConfig
  egressProxyRunning: boolean
  sandbox: BelaySandboxConfig
  sandboxBrokerActive: boolean
  l1FullActive: boolean
  transactionalEligible: boolean
  permission: string
  tier: string
  result: ClassifyResult
}

export interface StatusReport {
  repoRoot: string
  approvalStateDir: string
  pending: ApprovalRecord[]
  approved: ApprovalRecord[]
  expiredPendingCount: number
  dogfood: DogfoodStatus
  health: HealthSnapshot
  visibility: AuditVisibilityReport
}

export interface ReportOptions {
  targetDir?: string
  since?: string
  until?: string
  limit?: number
  json?: boolean
}

export interface AuditVisibilityReport {
  repoRoot: string
  auditLogPath: string
  gateEvents: number
  askCount: number
  flagCount: number
  allowCount: number
  silentPassRate: number
  recentAsks: Array<{
    timestamp?: string
    summary: string
    reason: string
    tier: 'Tier0' | 'Tier1' | 'deterministic'
  }>
  warnings: string[]
}

export interface RecoverOptions {
  targetDir?: string
  since?: string
  fingerprint?: string
  command?: string
  limit?: number
  json?: boolean
}

export interface RecoverReport {
  repoRoot: string
  target?: {
    timestamp?: string
    fingerprint?: string
    summary: string
    reason: string
    effect?: string
    location?: string
    permission?: string
  }
  recoverable: boolean
  confidence: 'high' | 'medium'
  disclaimer: string[]
  advice: string[]
  warnings: string[]
}

export interface DogfoodOptions {
  targetDir?: string
  enforce?: boolean
  force?: boolean
  adapter?: AdapterName
}

export interface DogfoodResult {
  ok: boolean
  repoRoot: string
  message: string
  configPath: string
  mode: string
  unknownLocalEffect: string
}

export type ExplainKind = 'shell' | 'tool' | 'subagent'

export interface ExplainReport {
  repoRoot: string
  kind: string
  command: string
  cwd: string
  policy: BelayPolicyConfig
  overrides: BelayOverridesConfig
  egress: BelayEgressConfig
  egressProxyRunning: boolean
  egressL3DemotionActive: boolean
  sandbox: BelaySandboxConfig
  sandboxBrokerActive: boolean
  l1FullActive: boolean
  transactionalEligible: boolean
  permission: string
  tier: string
  approvalId?: string
  result: ClassifyResult
}

export interface ExplainOptions {
  targetDir?: string
  command?: string
  cwd?: string
  json?: boolean
  kind?: ExplainKind
  toolName?: string
  payload?: Record<string, unknown>
  /** Re-classify the latest pending approval when no command is given. */
  explainLastPending?: boolean
}

export interface RevokeOptions {
  targetDir?: string
  approvalId: string
}
