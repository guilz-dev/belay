export declare function egressFingerprint(repoRoot: string, host: string, port: number, method: string, hasPayload?: boolean): string;
export declare function egressSummary(host: string, port: number, method?: string, hasPayload?: boolean): string;
export declare function parseHostFromSummary(summary: string): string | null;
