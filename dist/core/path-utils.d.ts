/**
 * Resolve symlinks for the longest existing prefix of `targetPath`, then append
 * any non-existent suffix without further resolution. Keeps path comparisons
 * symmetric when one side is a not-yet-created file (e.g. transactional diff,
 * fs-scope allowlist matching).
 */
export declare function canonicalPath(targetPath: string): string;
export declare function pathWithinRoot(root: string, targetPath: string): boolean;
export declare function relativeWithinRepo(repoRoot: string, targetPath: string): string | null;
export declare function normalizeToken(token: string, repoRoot: string): string;
export declare function resolveMutationTarget(token: string, cwd: string): string | null;
export declare function hasOutsideRepoPath(tokens: string[], cwd: string, repoRoot: string): boolean;
