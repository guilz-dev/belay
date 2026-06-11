import type { ClassifyResult } from '../types.js'
import { evaluateTransactionalDiff } from './diff-evaluator.js'
import {
  applyWorktreeChanges,
  collectWorktreeChanges,
  createGitWorktreeSnapshot,
  isGitWorktreeAvailable,
  resolveWorktreeCwd,
  runShellCommand,
} from './git-worktree.js'
import { TRANSACTIONAL_ALREADY_APPLIED, TRANSACTIONAL_OBSERVED_RISK } from './reasons.js'
import type { TransactionalExecutionResult, TransactionalRunnerParams } from './types.js'

export async function runTransactionalExecution(
  params: TransactionalRunnerParams,
): Promise<TransactionalExecutionResult> {
  const { predicted, repoRoot, stateDir, command, cwd, timeoutMs, diffContext } = params

  if (!(await isGitWorktreeAvailable(repoRoot))) {
    return {
      ok: false,
      skipped: true,
      skipReason: 'git_worktree_unavailable',
      predicted,
      result: predicted,
    }
  }

  let snapshot: Awaited<ReturnType<typeof createGitWorktreeSnapshot>> | null = null
  try {
    snapshot = await createGitWorktreeSnapshot(repoRoot, stateDir)
    const execCwd = resolveWorktreeCwd(repoRoot, snapshot.worktreePath, cwd)
    const shellResult = await runShellCommand(command, execCwd, timeoutMs)

    if (shellResult.timedOut) {
      return {
        ok: false,
        skipped: true,
        skipReason: 'transactional_timed_out',
        predicted,
        result: predicted,
        commandExitCode: shellResult.exitCode,
        commandSignal: shellResult.signal,
        timedOut: true,
      }
    }

    if (shellResult.exitCode !== 0 && shellResult.exitCode !== null) {
      return {
        ok: false,
        skipped: true,
        skipReason: 'transactional_command_failed',
        predicted,
        result: predicted,
        commandExitCode: shellResult.exitCode,
        commandSignal: shellResult.signal,
      }
    }

    const changes = await collectWorktreeChanges(snapshot.worktreePath)
    const observed = evaluateTransactionalDiff(changes, diffContext)

    if (observed.verdict === 'allow') {
      await applyWorktreeChanges(snapshot.worktreePath, repoRoot, changes)
    }

    const result: ClassifyResult = {
      ...predicted,
      verdict: observed.verdict === 'allow' ? 'allow' : 'deny_pending_approval',
      reason:
        observed.verdict === 'allow' ? TRANSACTIONAL_ALREADY_APPLIED : TRANSACTIONAL_OBSERVED_RISK,
      assessment: observed.assessment,
    }

    return {
      ok: true,
      predicted,
      observed,
      result,
      worktreePath: snapshot.worktreePath,
      commandExitCode: shellResult.exitCode,
      commandSignal: shellResult.signal,
      timedOut: shellResult.timedOut,
    }
  } catch (error) {
    return {
      ok: false,
      skipped: true,
      skipReason: error instanceof Error ? error.message : 'transactional_execution_failed',
      predicted,
      result: predicted,
    }
  } finally {
    if (snapshot) {
      await snapshot.cleanup()
    }
  }
}
