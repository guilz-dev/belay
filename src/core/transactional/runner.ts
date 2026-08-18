import {
  boundaryMountReadOnlyFromPrediction,
  runWithBoundaryRunnable,
} from '../capability/boundary-run.js'
import { hostIntegrationBoundaryContext } from '../capability/boundary-session.js'
import { resolveGuestWorkdir } from '../capability/boundary-workspace-mount.js'
import { canonicalPath, pathWithinRoot } from '../path-utils.js'
import {
  discardPreparedRecoveryCheckpoint,
  listRecoveryCheckpoints,
  markRecoveryCheckpointApplied,
  markRecoveryCheckpointApplying,
  markRecoveryCheckpointNeedsManualRepair,
  prepareRecoveryCheckpoint,
  reconcileRecoveryCheckpoint,
} from '../recovery/checkpoint.js'
import type { ClassifyResult } from '../types.js'
import { buildObservedChangesFromTransactional } from './apply-observed-changes.js'
import { selectTransactionalBackend } from './backend-selector.js'
import { evaluateTransactionalDiff } from './diff-evaluator.js'
import { FileCheckpointDiagnosticError } from './file-tree.js'
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

const TRANSACTIONAL_RESOURCE_IDENTITY_CHANGED = 'transactional_resource_identity_changed'

function errorChainIncludes(error: unknown, message: string): boolean {
  const seen = new Set<unknown>()
  let current = error
  while (current instanceof Error && !seen.has(current)) {
    if (current.message === message) return true
    seen.add(current)
    current = current.cause
  }
  return false
}

export async function runTransactionalExecution(
  params: TransactionalRunnerParams,
): Promise<TransactionalExecutionResult> {
  const { predicted, repoRoot, stateDir, command, cwd, timeoutMs, diffContext } = params
  const recoveryStateDir = canonicalPath(stateDir)
  const recoveryStateOutsideResource = !pathWithinRoot(repoRoot, recoveryStateDir)
  const backendContext = {
    repoRoot,
    stateDir: recoveryStateDir,
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
      transactionalBackend: selection.probe.backend,
      resourceKind: selection.probe.resourceKind,
    }
  }

  if (params.checkpoint?.enabled) {
    try {
      await listRecoveryCheckpoints(recoveryStateDir, repoRoot)
    } catch (error) {
      return {
        ok: false,
        skipped: true,
        skipReason: error instanceof Error ? error.message : 'recovery_checkpoint_reconcile_failed',
        predicted,
        result: predicted,
        transactionalBackend: selection.probe.backend,
        resourceKind: selection.probe.resourceKind,
      }
    }
  }

  let snapshot: Awaited<ReturnType<typeof selection.backend.prepare>> | null = null
  try {
    snapshot = await selection.backend.prepare(backendContext)
    const snapshotAudit = {
      transactionalBackend: snapshot.backend,
      resourceKind: snapshot.resourceKind,
      baselineTreeHash: snapshot.baselineTreeHash,
      snapshotFileCount: snapshot.snapshotFileCount,
      snapshotSourceBytes: snapshot.snapshotSourceBytes,
      snapshotWorkspaceBytes: snapshot.snapshotWorkspaceBytes,
      snapshotCopyStrategy: snapshot.copyStrategy,
      snapshotPrepareMs: snapshot.snapshotPrepareMs,
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
              stateDir: recoveryStateDir,
              repoRoot,
              baselinePath: snapshot.baselineRoot ?? repoRoot,
              worktreePath: snapshot.executionRoot,
              commandFingerprint: predicted.fingerprint,
              changes,
              protectedRoots: diffContext.protectedRoots,
              config: params.checkpoint,
              backend: snapshot.backend,
              expectedResourceIdentity: snapshot.resourceIdentity,
            })
          : null
      try {
        if (checkpoint) {
          await markRecoveryCheckpointApplying(recoveryStateDir, checkpoint)
        }
        let receipt: Awaited<ReturnType<typeof markRecoveryCheckpointApplied>> | undefined
        const validateResourceIdentity = snapshot.validateResourceIdentity
        await applyWorktreeChanges(snapshot.executionRoot, repoRoot, changes, {
          observedChanges,
          beforeMutation: validateResourceIdentity
            ? async () => {
                try {
                  await validateResourceIdentity()
                } catch (error) {
                  throw new Error(TRANSACTIONAL_RESOURCE_IDENTITY_CHANGED, { cause: error })
                }
              }
            : undefined,
          afterApply: checkpoint
            ? async () => {
                receipt = await markRecoveryCheckpointApplied(recoveryStateDir, checkpoint)
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
        const toctou = error instanceof Error && error.message === TRANSACTIONAL_APPLY_TOCTOU
        const rollbackFailed =
          error instanceof Error && error.message === TRANSACTIONAL_APPLY_ROLLBACK_FAILED
        const resourceIdentityChanged = errorChainIncludes(
          error,
          TRANSACTIONAL_RESOURCE_IDENTITY_CHANGED,
        )
        const recoveryStateUnavailable =
          !recoveryStateOutsideResource && (rollbackFailed || resourceIdentityChanged)
        if (checkpoint) {
          if (recoveryStateUnavailable) {
            // The resource path may now resolve to attacker-controlled replacement bytes.
            // Leave the original artifact in applying state instead of touching that path.
          } else if (rollbackFailed) {
            await markRecoveryCheckpointNeedsManualRepair(
              recoveryStateDir,
              checkpoint.checkpointId,
              TRANSACTIONAL_APPLY_ROLLBACK_FAILED,
            )
          } else {
            const recoveryState = await reconcileRecoveryCheckpoint(
              recoveryStateDir,
              checkpoint.checkpointId,
            )
            if (recoveryState === 'prepared') {
              await discardPreparedRecoveryCheckpoint(recoveryStateDir, checkpoint.checkpointId)
            }
          }
        }
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
                : toctou || resourceIdentityChanged
                  ? 'transactional_apply_toctou'
                  : 'transactional_apply_failed',
              ...(recoveryStateUnavailable ? ['transactional_recovery_state_unavailable'] : []),
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
      ...(error instanceof FileCheckpointDiagnosticError ? { skipDetail: error.diagnostic } : {}),
      predicted,
      result: predicted,
      ...(snapshot
        ? {
            transactionalBackend: snapshot.backend,
            resourceKind: snapshot.resourceKind,
            baselineTreeHash: snapshot.baselineTreeHash,
            snapshotFileCount: snapshot.snapshotFileCount,
            snapshotSourceBytes: snapshot.snapshotSourceBytes,
            snapshotWorkspaceBytes: snapshot.snapshotWorkspaceBytes,
            snapshotCopyStrategy: snapshot.copyStrategy,
            snapshotPrepareMs: snapshot.snapshotPrepareMs,
          }
        : {
            transactionalBackend: selection.probe.backend,
            resourceKind: selection.probe.resourceKind,
          }),
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
