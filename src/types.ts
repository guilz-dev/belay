export type {
  BelayConfig,
  BelayConfigV1,
  BelayConfigV2,
  BelayConfigV3,
  BelayControlPlaneConfig,
  BelayMode,
  BelayOverridesConfig,
  BelayPolicyConfig,
  BelayRedactionConfig,
  UnknownLocalEffectPolicy,
} from './core/config.js'
export type {
  ApprovalRecord,
  ApprovalStateFile,
  Assessment,
  ClassifyResult,
  HookVerdict,
} from './core/types.js'

import type { BelayOverridesConfig, BelayPolicyConfig } from './core/config.js'
import type { ApprovalRecord, ClassifyResult } from './core/types.js'

export interface HookEntry {
  command: string
  matcher?: string
}

export interface HooksFile {
  version: number
  hooks: Record<string, HookEntry[]>
}

export interface InitOptions {
  targetDir?: string
  withSkill?: boolean
}

export interface UpgradeOptions {
  targetDir?: string
  withSkill?: boolean
}

export interface DoctorOptions {
  targetDir?: string
  fix?: boolean
  dryRun?: boolean
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
}

export type ExplainKind = 'shell' | 'tool' | 'subagent'

export interface ExplainReport {
  repoRoot: string
  kind: string
  command: string
  cwd: string
  policy: BelayPolicyConfig
  overrides: BelayOverridesConfig
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
