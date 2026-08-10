import type { ShellRunResult } from '../transactional/git-worktree.js'
import type { ClassifyResult } from '../types.js'

export interface BoundaryWorkspaceMount {
  hostSourceRoot: string
  guestTargetRoot: string
  cwdRelative: string
  writable: boolean
  hideHostSourcePath: boolean
}

export interface BoundaryRunOptions {
  /** When true, container driver mounts the working directory read-only. */
  mountReadOnly?: boolean
  workspaceMount?: BoundaryWorkspaceMount
}

export interface BoundaryPrepareContext {
  repoRoot?: string
  egressProxyActive: boolean
  proxyEnv: Record<string, string>
}

export interface BoundaryRunnable {
  prepare?(context: BoundaryPrepareContext): Promise<void>
  run(
    command: string,
    cwd: string,
    timeoutMs: number,
    options?: BoundaryRunOptions,
  ): Promise<ShellRunResult>
}

export function boundaryMountReadOnlyFromPrediction(predicted: ClassifyResult): boolean {
  const effect = predicted.axes?.effect
  if (effect === 'local_mutation' || effect === 'remote_mutation') {
    return false
  }

  for (const request of predicted.capabilityRequests ?? []) {
    if (
      request.action === 'fs.write' ||
      request.action === 'git.ref.write' ||
      request.action === 'control_plane.write'
    ) {
      return false
    }
  }

  return true
}

export async function runWithBoundaryRunnable(
  target: BoundaryRunnable,
  params: {
    prepareContext: BoundaryPrepareContext
    command: string
    cwd: string
    timeoutMs: number
    runOptions?: BoundaryRunOptions
  },
): Promise<ShellRunResult> {
  if (target.prepare) {
    await target.prepare(params.prepareContext)
  }
  return target.run(params.command, params.cwd, params.timeoutMs, params.runOptions)
}
