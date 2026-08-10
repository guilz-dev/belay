import {
  boundaryMountReadOnlyFromPrediction,
  runWithBoundaryRunnable,
} from '../capability/boundary-run.js'
import { hostIntegrationBoundaryContext } from '../capability/boundary-session.js'
import { resolveGuestWorkdir } from '../capability/boundary-workspace-mount.js'
import {
  discardPreparedRecoveryCheckpoint,
  listRecoveryCheckpoints,
  markRecoveryCheckpointApplied,
  markRecoveryCheckpointApplying,
  prepareRecoveryCheckpoint,
  reconcileRecoveryCheckpoint,
} from '../recovery/checkpoint.js'
import type { ClassifyResult } from '../types.js'
import { buildObservedChangesFromTransactional } from './apply-observed-changes.js'
import { selectTransactionalBackend } from './backend-selector.js'
import { evaluateTransactionalDiff } from './diff-evaluator.js'
import {
  applyWorktreeChanges,
  resolveWorktreeCwd,
  TRANSACTIONAL_APPLY_ROLLBACK_FAILED,
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
    boundaryAttestation: params.boundaryContext?.attestation ?? null,
    boundaryAttestationFresh: params.boundaryContext?.attestationFresh ?? false,
    boundaryDriverId: params.boundaryContext?.driverId,
  }

  const selection = await selectTransactionalBackend(backendContext)
  if (!selection.backend) {
    const skipReason = params.fileCheckpoint.enabled
      ? (selection.probe.reason ?? selection.skipReason)
      : (selection.skipReason ?? selection.probe.reason)
    return {
      ok: false,
      skipped: true,
      skipReason: skipReason ?? 'transactional_execution_failed',
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
    const snapshotAudit = {
      transactionalBackend: snapshot.backend,
      transactionalBaselineTreeHash: snapshot.baselineTreeHash,
      ...(snapshot.copyStrategy ? { transactionalCopyStrategy: snapshot.copyStrategy } : {}),
    }
    const runOptions =
      snapshot.backend === 'file_checkpoint' && snapshot.executionCwdRelative !== undefined
        ? {
            mountReadOnly: boundaryMountReadOnlyFromPrediction(predicted),
            workspaceMount: {
              hostSourceRoot: snapshot.executionRoot,
              guestTargetRoot: snapshot.resourceRoot,
              cwdRelative: snapshot.executionCwdRelative,
              writable: true,
              hideHostSourcePath: true,
            },
          }
        : {
            mountReadOnly: boundaryMountReadOnlyFromPrediction(predicted),
          }
    const execCwd =
      snapshot.backend === 'file_checkpoint' && runOptions.workspaceMount
        ? resolveGuestWorkdir(runOptions.workspaceMount)
        : resolveWorktreeCwd(repoRoot, snapshot.executionRoot, cwd)
    const boundaryContext =
      params.boundaryContext ?? hostIntegrationBoundaryContext(params.repoRoot)
    const shellResult = await runWithBoundaryRunnable(boundaryContext.driver, {
      prepareContext: boundaryContext.prepareContext,
      command,
      cwd: execCwd,
      timeoutMs,
      runOptions,
    })

    if (shellResult.timedOut) {
      return {
        ok: false,
        skipped: true,
        skipReason: 'transactional_timed_out',
        predicted,
        result: predicted,
        ...snapshotAudit,
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
        ...snapshotAudit,
        commandExitCode: shellResult.exitCode,
        commandSignal: shellResult.signal,
      }
    }

    const changes = await snapshot.collectChanges()
    const observed = evaluateTransactionalDiff(changes, diffContext)

    if (observed.verdict === 'allow') {
      await snapshot.validateSourceState?.()
      const observedChanges = await buildObservedChangesFromTransactional(
        snapshot.baselineRoot ?? repoRoot,
        snapshot.executionRoot,
        changes,
      )
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
              backend: snapshot.backend,
            })
          : null
      try {
        if (checkpoint) {
          await markRecoveryCheckpointApplying(stateDir, checkpoint)
        }
        let receipt: Awaited<ReturnType<typeof markRecoveryCheckpointApplied>> | undefined
        await applyWorktreeChanges(snapshot.executionRoot, repoRoot, changes, {
          observedChanges,
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
          ...snapshotAudit,
          commandExitCode: shellResult.exitCode,
          commandSignal: shellResult.signal,
          timedOut: shellResult.timedOut,
          ...(checkpoint && receipt
            ? {
                recoveryCheckpointId: checkpoint.checkpointId,
                recoveryBackend: snapshot.backend,
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
        const rollbackFailed =
          error instanceof Error && error.message === TRANSACTIONAL_APPLY_ROLLBACK_FAILED
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
              rollbackFailed
                ? 'transactional_apply_rollback_failed'
                : toctou
                  ? 'transactional_apply_toctou'
                  : 'transactional_apply_failed',
            ],
          },
        }
        return {
          ok: true,
          predicted,
          observed,
          result,
          worktreePath: snapshot.executionRoot,
          ...snapshotAudit,
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
      ...snapshotAudit,
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
      ...(snapshot
        ? {
            transactionalBackend: snapshot.backend,
            transactionalBaselineTreeHash: snapshot.baselineTreeHash,
            ...(snapshot.copyStrategy ? { transactionalCopyStrategy: snapshot.copyStrategy } : {}),
          }
        : {}),
    }
  } finally {
    if (snapshot) {
      try {
        await snapshot.cleanup()
      } catch {
        // Cleanup is best effort and must not overturn a verified apply or observed-risk result.
      }
    }
  }
}
