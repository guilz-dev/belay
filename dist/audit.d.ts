import type { AuditRecord } from './core/audit-types.js';
export type AuditSubcommand = 'query' | 'summarize' | 'replay';
export interface AuditOptions {
    targetDir?: string;
    subcommand: AuditSubcommand;
    json?: boolean;
    since?: string;
    until?: string;
    verdict?: string;
    reason?: string;
    kind?: string;
    fingerprint?: string;
    event?: string;
    limit?: number;
    configPath?: string;
}
export declare function auditProject(options: AuditOptions): Promise<{
    subcommand: string;
    records: AuditRecord[];
    count: number;
    roundTrips?: undefined;
    lines?: undefined;
    bypassAttempts?: undefined;
    noisyRules?: undefined;
    candidateConfigPath?: undefined;
    changedCount?: undefined;
    diffs?: undefined;
} | {
    subcommand: string;
    roundTrips: import("./core/audit-types.js").ApprovalRoundTrip[];
    lines: string[];
    bypassAttempts: import("./core/audit-types.js").BypassAttempt[];
    noisyRules: import("./core/audit-types.js").NoisyRuleCandidate[];
    records?: undefined;
    count?: undefined;
    candidateConfigPath?: undefined;
    changedCount?: undefined;
    diffs?: undefined;
} | {
    subcommand: string;
    candidateConfigPath: string | null;
    changedCount: number;
    diffs: import("./core/reclassify.js").ReclassifyDiff[];
    records?: undefined;
    count?: undefined;
    roundTrips?: undefined;
    lines?: undefined;
    bypassAttempts?: undefined;
    noisyRules?: undefined;
}>;
export declare function formatAuditReport(report: Awaited<ReturnType<typeof auditProject>>): string;
