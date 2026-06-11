export interface ApprovalTokenPayload {
    approvalId: string;
    fingerprint: string;
    repoRoot: string;
    issuedAt: string;
    expiresAt: string;
}
export declare function approvalSigningKeyPath(controlPlaneDir?: string): string;
export declare function loadOrCreateApprovalSigningKey(controlPlaneDir?: string): Promise<Buffer>;
export declare function issueApprovalToken(payload: ApprovalTokenPayload, controlPlaneDir?: string): Promise<string>;
export declare function verifyApprovalToken(token: string, controlPlaneDir?: string): Promise<ApprovalTokenPayload | null>;
