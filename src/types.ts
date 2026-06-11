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

export type AdapterName = 'cursor' | 'claude'

export interface InitOptions {
  targetDir?: string
  withSkill?: boolean
  dogfood?: boolean
  adapter?: AdapterName
}

export interface UpgradeOptions {
  targetDir?: string
  withSkill?: boolean
  adapter?: AdapterName
}

export interface DoctorOptions {
  targetDir?: string
  fix?: boolean
  dryRun?: boolean
  adapter?: AdapterName
}

export interface Oq3SpikeStatus {
  path: string
  ok: boolean
  recordedAt: string | null
  error: string | null
  controlPlaneDir: string
}

export interface DogfoodStatus {
  active: boolean
  mode: string
  unknownLocalEffect: string
  spikeOnPrompt: boolean
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
  oq3Spike: Oq3SpikeStatus | null
}

export interface StatusOptions {
  targetDir?: string
  json?: boolean
}

export interface StatusReport {
  repoRoot: string
  approvalStateDir: string
  pending: ApprovalRecord[]
  approved: ApprovalRecord[]
  expiredPendingCount: number
  dogfood: DogfoodStatus
  oq3Spike: Oq3SpikeStatus | null
}

export interface DogfoodOptions {
  targetDir?: string
  enforce?: boolean
  force?: boolean
  spikeOnPrompt?: boolean
  adapter?: AdapterName
}

export interface DogfoodResult {
  ok: boolean
  repoRoot: string
  message: string
  configPath: string
  mode: string
  unknownLocalEffect: string
  spikeOnPrompt: boolean
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
}

export interface RevokeOptions {
  targetDir?: string
  approvalId: string
}
