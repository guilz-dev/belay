import type { ShellRunResult } from '../transactional/git-worktree.js'
import type { ClassifyResult } from '../types.js'

const SAFE_CONTAINER_RESOURCE_ID =
  /^belay-run-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

export interface BoundaryCleanupFailure {
  code: 'BOUNDARY_CLEANUP_UNCONFIRMED'
  resourceKind: 'container'
  resourceId: string
  executionStarted: true
  cleanupConfirmed: false
}

export class BoundaryCleanupError extends Error implements BoundaryCleanupFailure {
  readonly code = 'BOUNDARY_CLEANUP_UNCONFIRMED' as const
  readonly executionStarted = true as const
  readonly cleanupConfirmed = false as const

  constructor(
    readonly resourceKind: 'container',
    readonly resourceId: string,
  ) {
    super('Boundary cleanup could not be confirmed')
    this.name = 'BoundaryCleanupError'
  }
}

export function isBoundaryCleanupError(value: unknown): value is BoundaryCleanupFailure {
  if (!value || typeof value !== 'object') {
    return false
  }
  const candidate = value as Record<string, unknown>
  return (
    candidate.code === 'BOUNDARY_CLEANUP_UNCONFIRMED' &&
    candidate.resourceKind === 'container' &&
    typeof candidate.resourceId === 'string' &&
    candidate.executionStarted === true &&
    candidate.cleanupConfirmed === false
  )
}

export function safeBoundaryCleanupResourceId(value: unknown): string | undefined {
  if (!isBoundaryCleanupError(value) || !SAFE_CONTAINER_RESOURCE_ID.test(value.resourceId)) {
    return undefined
  }
  return value.resourceId
}

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
