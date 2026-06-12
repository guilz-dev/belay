export type VerdictPermission = 'allow' | 'ask';
export type VerdictLocation = 'repo_local' | 'repo_outside' | 'external' | 'mixed' | 'unknown';
export type VerdictOpacity = 'transparent' | 'recursive' | 'opaque' | 'unparseable';
export type VerdictEffect = 'read_only' | 'local_mutation' | 'remote_mutation' | 'unknown';
export type VerdictConfidence = 'deterministic' | 'llm' | 'assumed_repo_local' | 'verified_substrate';
export interface VerdictResult {
    permission: VerdictPermission;
    location: VerdictLocation;
    opacity: VerdictOpacity;
    effect: VerdictEffect;
    confidence: VerdictConfidence;
    reason: string;
    commandRedacted: string;
    fingerprint: string;
    signals: string[];
}
export interface Tier1Verdict {
    external_change: boolean;
    destroys_outside_repo: boolean;
    destroys_history_or_secrets: boolean;
}
export interface Tier1Judge {
    evaluate(input: {
        command: string;
        innerCode?: string;
        head: string;
    }): Promise<Tier1Verdict>;
}
export type VerdictMode = 'enforce' | 'audit';
export interface VerdictContext {
    cwd: string;
    repoRoot: string;
    trustedCwd: boolean;
    sensitivePaths: string[];
    protectedArtifactRoots?: string[];
    judge: Tier1Judge;
    mode: VerdictMode;
    unknownLocalEffect: 'allow_flagged' | 'deny';
    unparseableShell: 'allow_flagged' | 'deny';
    maxRecursionDepth?: number;
}
export interface InternalSegmentVerdict {
    permission: VerdictPermission;
    location: VerdictLocation;
    opacity: VerdictOpacity;
    effect: VerdictEffect;
    confidence: VerdictConfidence;
    reason: string;
    signals: string[];
}
