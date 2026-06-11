export type CapabilityApprovalScope = 'once' | 'path';
export interface FsScopeAllowlistEntry {
    path: string;
    approvedAt: string;
    approvalId: string;
}
export interface FsScopeAllowlistFile {
    version: 1;
    paths: FsScopeAllowlistEntry[];
}
