export interface DenyNotificationConfig {
    webhookUrl?: string;
    commandHook?: string;
}
export interface DenyNotificationEvent {
    approvalId: string;
    reason: string;
    summary: string;
    repoRoot: string;
    fingerprint: string;
    approvalToken?: string;
}
export declare function notifyDeny(config: DenyNotificationConfig, event: DenyNotificationEvent): Promise<void>;
