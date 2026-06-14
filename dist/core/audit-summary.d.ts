import type { AuditFilter, AuditRecord } from './audit-types.js';
export type AuditTier = 'Tier0' | 'Tier1' | 'deterministic';
export interface RecentAskEntry {
    timestamp?: string;
    summary: string;
    reason: string;
    tier: AuditTier;
}
export interface AuditVisibilitySummary {
    gateEvents: number;
    askCount: number;
    enforceAskCount: number;
    auditAskCount: number;
    unknownModeAskCount: number;
    flagCount: number;
    allowCount: number;
    silentPassRate: number;
    recentAsks: RecentAskEntry[];
}
export declare const DEFAULT_SILENT_PASS_THRESHOLD = 0.5;
export declare const MIN_GATE_EVENTS_FOR_FENCE_DRIFT = 20;
export interface FenceDriftOptions {
    threshold?: number;
}
export declare function inferAuditTier(record: AuditRecord): AuditTier;
export declare function formatAskBreakdown(summary: Pick<AuditVisibilitySummary, 'askCount' | 'enforceAskCount' | 'auditAskCount' | 'unknownModeAskCount'>, indent?: string): string[];
export declare function summarizeAuditVisibility(records: AuditRecord[], filter?: AuditFilter, options?: {
    recentAskLimit?: number;
}): AuditVisibilitySummary;
export declare function detectFenceDrift(summary: Pick<AuditVisibilitySummary, 'gateEvents' | 'silentPassRate'>, options?: FenceDriftOptions): {
    warnings: string[];
    notes: string[];
};
