export declare function relativeWithinRepo(repoRoot: string, targetPath: string): string | null;
export declare function normalizeToken(token: string, repoRoot: string): string;
export declare function resolveMutationTarget(token: string, cwd: string): string | null;
export declare function hasOutsideRepoPath(tokens: string[], cwd: string, repoRoot: string): boolean;
