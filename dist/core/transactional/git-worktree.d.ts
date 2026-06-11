import type { TransactionalFileChange, TransactionalSnapshot } from './types.js';
export declare function isGitWorktreeAvailable(repoRoot: string): Promise<boolean>;
export declare function isDirtyWorktree(repoRoot: string): Promise<boolean>;
export declare function createGitWorktreeSnapshot(repoRoot: string, stateDir: string): Promise<TransactionalSnapshot>;
export declare function resolveWorktreeCwd(repoRoot: string, worktreePath: string, cwd: string): string;
export interface ShellRunResult {
    exitCode: number | null;
    signal: string | null;
    timedOut: boolean;
}
export declare function runShellCommand(command: string, cwd: string, timeoutMs: number): Promise<ShellRunResult>;
export declare function collectWorktreeChanges(worktreePath: string): Promise<TransactionalFileChange[]>;
export declare function applyWorktreeChanges(worktreePath: string, repoRoot: string, changes: TransactionalFileChange[]): Promise<void>;
