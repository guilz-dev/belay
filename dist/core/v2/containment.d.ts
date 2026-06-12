import type { VerdictLocation } from './types.js';
export interface PathTargetAnalysis {
    location: VerdictLocation;
    isHighStakes: boolean;
    signals: string[];
}
export declare function resolveTrustedPath(token: string, trustedCwd: string, trusted: boolean): string | null;
export declare function locationForPath(resolvedPath: string | null, repoRoot: string): VerdictLocation;
export declare function isGitPath(resolvedPath: string, repoRoot: string): boolean;
export declare function isHighStakesPath(resolvedPath: string, repoRoot: string, sensitivePaths: string[], protectedRoots?: string[]): boolean;
export declare function analyzePathTargets(params: {
    targets: string[];
    cwd: string;
    repoRoot: string;
    trustedCwd: boolean;
    sensitivePaths: string[];
    protectedArtifactRoots?: string[];
}): PathTargetAnalysis;
export declare function cwdRelative(repoRoot: string, cwd: string): string;
