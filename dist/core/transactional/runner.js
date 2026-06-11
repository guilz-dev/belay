import { evaluateTransactionalDiff } from './diff-evaluator.js';
import { applyWorktreeChanges, collectWorktreeChanges, createGitWorktreeSnapshot, isGitWorktreeAvailable, resolveWorktreeCwd, runShellCommand, } from './git-worktree.js';
export async function runTransactionalExecution(params) {
    const { predicted, repoRoot, stateDir, command, cwd, timeoutMs, diffContext } = params;
    if (!(await isGitWorktreeAvailable(repoRoot))) {
        return {
            ok: false,
            skipped: true,
            skipReason: 'git_worktree_unavailable',
            predicted,
            result: predicted,
        };
    }
    let snapshot = null;
    try {
        snapshot = await createGitWorktreeSnapshot(repoRoot, stateDir);
        const execCwd = resolveWorktreeCwd(repoRoot, snapshot.worktreePath, cwd);
        const shellResult = await runShellCommand(command, execCwd, timeoutMs);
        const changes = await collectWorktreeChanges(snapshot.worktreePath);
        const observed = evaluateTransactionalDiff(changes, diffContext);
        if (observed.verdict === 'allow') {
            await applyWorktreeChanges(snapshot.worktreePath, repoRoot, changes);
        }
        const result = {
            ...predicted,
            verdict: observed.verdict,
            reason: observed.reason,
            assessment: observed.assessment,
        };
        return {
            ok: true,
            predicted,
            observed,
            result,
            worktreePath: snapshot.worktreePath,
            commandExitCode: shellResult.exitCode,
            commandSignal: shellResult.signal,
            timedOut: shellResult.timedOut,
        };
    }
    catch (error) {
        return {
            ok: false,
            skipped: true,
            skipReason: error instanceof Error ? error.message : 'transactional_execution_failed',
            predicted,
            result: predicted,
        };
    }
    finally {
        if (snapshot) {
            await snapshot.cleanup();
        }
    }
}
