export type { BelayConfig, BelayConfigV1, BelayConfigV2, BelayMode } from './core/config.js';
export type { ApprovalRecord, ApprovalStateFile, Assessment, ClassifyResult, HookVerdict, } from './core/types.js';
import type { ApprovalRecord } from './core/types.js';
export interface HookEntry {
    command: string;
    matcher?: string;
}
export interface HooksFile {
    version: number;
    hooks: Record<string, HookEntry[]>;
}
export interface InitOptions {
    targetDir?: string;
    withSkill?: boolean;
}
export interface UpgradeOptions {
    targetDir?: string;
    withSkill?: boolean;
}
export interface DoctorOptions {
    targetDir?: string;
}
export interface DoctorReport {
    ok: boolean;
    repoRoot: string;
    configPath: string;
    hooksPath: string;
    nodeResolution: {
        ok: boolean;
        detail: string;
        path?: string;
    };
    issues: string[];
    notes: string[];
    warnings: string[];
}
export interface StatusOptions {
    targetDir?: string;
    json?: boolean;
}
export interface StatusReport {
    repoRoot: string;
    pending: ApprovalRecord[];
    approved: ApprovalRecord[];
    expiredPendingCount: number;
}
export type ExplainKind = 'shell' | 'tool' | 'subagent';
export interface ExplainOptions {
    targetDir?: string;
    command?: string;
    cwd?: string;
    json?: boolean;
    kind?: ExplainKind;
    toolName?: string;
    payload?: Record<string, unknown>;
}
export interface RevokeOptions {
    targetDir?: string;
    approvalId: string;
}
