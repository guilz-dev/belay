export interface ApproveOptions {
    targetDir?: string;
    approvalId: string;
    token?: string;
}
export declare function approvePending(options: ApproveOptions): Promise<{
    ok: boolean;
    message: string;
}>;
