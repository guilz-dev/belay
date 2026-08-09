import {
  boundaryMountReadOnlyFromPrediction,
  runWithBoundaryRunnable,
} from '../capability/boundary-run.js'
import { hostIntegrationBoundaryContext } from '../capability/boundary-session.js'
import {
  discardPreparedRecoveryCheckpoint,
  listRecoveryCheckpoints,
  markRecoveryCheckpointApplied,
  markRecoveryCheckpointApplying,
  prepareRecoveryCheckpoint,
  reconcileRecoveryCheckpoint,
} from '../recovery/checkpoint.js'
import type { ClassifyResult } from '../types.js'
import { selectTransactionalBackend } from './backend-selector.js'
import { evaluateTransactionalDiff } from './diff-evaluator.js'
import {
  applyWorktreeChanges,
  captureRepoFileHashes,
  resolveWorktreeCwd,
  TRANSACTIONAL_APPLY_TOCTOU,
} from './git-worktree.js'
import {
  TRANSACTIONAL_ALREADY_APPLIED,
  TRANSACTIONAL_APPLY_FAILED,
  TRANSACTIONAL_OBSERVED_RISK,
} from './reasons.js'
import type { TransactionalExecutionResult, TransactionalRunnerParams } from './types.js'

export async function runTransactionalExecution(
  params: TransactionalRunnerParams,
): Promise<TransactionalExecutionResult> {
  const { predicted, repoRoot, stateDir, command, cwd, timeoutMs, diffContext } = params
  const backendContext = {
    repoRoot,
    stateDir,
    cwd,
    dirtyIgnoreRoots: params.dirtyIgnoreRoots,
    fileCheckpoint: params.fileCheckpoint,
    durableCheckpointEnabled: params.checkpoint?.enabled === true,
  }

  const selection = await selectTransactionalBackend(backendContext)
  if (!selection.backend) {
    return {
      ok: false,
      skipped: true,
      skipReason:
        selection.skipReason ?? selection.probe.reason ?? 'transactional_execution_failed',
      predicted,
      result: predicted,
    }
  }

  if (params.checkpoint?.enabled) {
    try {
      await listRecoveryCheckpoints(stateDir, repoRoot)
    } catch (error) {
      return {
        ok: false,
        skipped: true,
        skipReason: error instanceof Error ? error.message : 'recovery_checkpoint_reconcile_failed',
        predicted,
        result: predicted,
      }
    }
  }

  let snapshot: Awaited<ReturnType<typeof selection.backend.prepare>> | null = null
  try {
    snapshot = await selection.backend.prepare(backendContext)
    const execCwd = resolveWorktreeCwd(repoRoot, snapshot.executionRoot, cwd)
    const boundaryContext =
      params.boundaryContext ?? hostIntegrationBoundaryContext(params.repoRoot)
    const shellResult = await runWithBoundaryRunnable(boundaryContext.driver, {
      prepareContext: boundaryContext.prepareContext,
      command,
      cwd: execCwd,
      timeoutMs,
      runOptions: {
        mountReadOnly: boundaryMountReadOnlyFromPrediction(predicted),
      },
    })

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

    const changes = await snapshot.collectChanges()
    const observed = evaluateTransactionalDiff(changes, diffContext)

    if (observed.verdict === 'allow') {
      const baseHashes = await captureRepoFileHashes(repoRoot, changes)
      const checkpoint =
        params.checkpoint?.enabled && changes.length > 0
          ? await prepareRecoveryCheckpoint({
              stateDir,
              repoRoot,
              worktreePath: snapshot.executionRoot,
              commandFingerprint: predicted.fingerprint,
              changes,
              protectedRoots: diffContext.protectedRoots,
              config: params.checkpoint,
            })
          : null
      try {
        if (checkpoint) {
          await markRecoveryCheckpointApplying(stateDir, checkpoint)
        }
        let receipt: Awaited<ReturnType<typeof markRecoveryCheckpointApplied>> | undefined
        await applyWorktreeChanges(snapshot.executionRoot, repoRoot, changes, {
          baseHashes,
          afterApply: checkpoint
            ? async () => {
                receipt = await markRecoveryCheckpointApplied(stateDir, checkpoint)
              }
            : undefined,
        })

        const result: ClassifyResult = {
          ...predicted,
          verdict: 'allow',
          reason: TRANSACTIONAL_ALREADY_APPLIED,
          assessment: observed.assessment,
        }
        return {
          ok: true,
          predicted,
          observed,
          result,
          worktreePath: snapshot.executionRoot,
          commandExitCode: shellResult.exitCode,
          commandSignal: shellResult.signal,
          timedOut: shellResult.timedOut,
          ...(checkpoint && receipt
            ? {
                recoveryCheckpointId: checkpoint.checkpointId,
                recoveryBackend: 'git_worktree' as const,
                recoveryProofHash: receipt.proofHash,
                recoveryState: 'applied' as const,
              }
            : {}),
        }
      } catch (error) {
        if (checkpoint) {
          const recoveryState = await reconcileRecoveryCheckpoint(stateDir, checkpoint.checkpointId)
          if (recoveryState === 'prepared') {
            await discardPreparedRecoveryCheckpoint(stateDir, checkpoint.checkpointId)
          }
        }
        const toctou = error instanceof Error && error.message === TRANSACTIONAL_APPLY_TOCTOU
        const result: ClassifyResult = {
          ...predicted,
          verdict: 'deny_pending_approval',
          reason: TRANSACTIONAL_APPLY_FAILED,
          assessment: {
            ...observed.assessment,
            reversibility: 'irreversible',
            confidence: 1,
            signals: [
              ...observed.assessment.signals,
              toctou ? 'transactional_apply_toctou' : 'transactional_apply_failed',
            ],
          },
        }
        return {
          ok: true,
          predicted,
          observed,
          result,
          worktreePath: snapshot.executionRoot,
          commandExitCode: shellResult.exitCode,
          commandSignal: shellResult.signal,
          timedOut: shellResult.timedOut,
        }
      }
    }

    const result: ClassifyResult = {
      ...predicted,
      verdict: 'deny_pending_approval',
      reason: TRANSACTIONAL_OBSERVED_RISK,
      assessment: observed.assessment,
    }

    return {
      ok: true,
      predicted,
      observed,
      result,
      worktreePath: snapshot.executionRoot,
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
