import { copyFile, lstat, mkdir, mkdtemp, readlink, rm, rmdir, symlink } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { ObservedFileChange } from './file-tree.js'
import { joinRelativePath, validateRelativePath } from './file-tree-path.js'
import { readSnapshotNode, type SnapshotNode, snapshotNodesEqual } from './snapshot-node.js'
import type { TransactionalFileChange } from './types.js'

export const TRANSACTIONAL_APPLY_TOCTOU = 'transactional_apply_toctou'
export const TRANSACTIONAL_APPLY_CONFLICT = 'transactional_apply_conflict'

type ApplyRollbackAction =
  | { type: 'restore'; target: string; backupPath: string }
  | { type: 'remove'; target: string }

export interface ApplyObservedChangesParams {
  sourceRoot: string
  targetRoot: string
  changes: ObservedFileChange[]
  afterApply?: () => Promise<void>
}

async function chmodSafe(target: string, mode: number): Promise<void> {
  try {
    const { chmod } = await import('node:fs/promises')
    await chmod(target, mode & 0o777)
  } catch {
    // best effort
  }
}

async function copyPathPreservingType(source: string, target: string): Promise<void> {
  const info = await lstat(source)
  await rm(target, { force: true, recursive: false })
  await mkdir(path.dirname(target), { recursive: true })
  if (info.isSymbolicLink()) {
    await symlink(await readlink(source), target)
    return
  }
  if (info.isDirectory() && !info.isSymbolicLink()) {
    await mkdir(target, { recursive: true, mode: info.mode & 0o777 })
    return
  }
  if (!info.isFile()) {
    throw new Error(TRANSACTIONAL_APPLY_CONFLICT)
  }
  await copyFile(source, target)
  await chmodSafe(target, info.mode)
}

async function assertParentDirectory(target: string): Promise<void> {
  const parent = path.dirname(target)
  if (parent === target) {
    return
  }
  let info: Awaited<ReturnType<typeof lstat>>
  try {
    info = await lstat(parent)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(TRANSACTIONAL_APPLY_CONFLICT)
    }
    throw error
  }
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new Error(TRANSACTIONAL_APPLY_CONFLICT)
  }
}

async function rollbackAppliedChanges(actions: ApplyRollbackAction[]): Promise<void> {
  for (const action of [...actions].reverse()) {
    try {
      if (action.type === 'restore') {
        await copyPathPreservingType(action.backupPath, action.target)
      } else {
        await rm(action.target, { force: true })
      }
    } catch {
      // best effort
    }
  }
}

async function assertTargetMatches(targetRoot: string, change: ObservedFileChange): Promise<void> {
  const target = joinRelativePath(targetRoot, change.relativePath)
  const current = await readSnapshotNode(target)
  if (!snapshotNodesEqual(current, change.before)) {
    throw new Error(TRANSACTIONAL_APPLY_TOCTOU)
  }
}

async function assertTargetMatchesAfter(
  targetRoot: string,
  change: ObservedFileChange,
): Promise<void> {
  const target = joinRelativePath(targetRoot, change.relativePath)
  const current = await readSnapshotNode(target)
  if (!snapshotNodesEqual(current, change.after)) {
    throw new Error(TRANSACTIONAL_APPLY_CONFLICT)
  }
}

function applyRank(change: ObservedFileChange): number {
  if (change.after.kind === 'directory') {
    return 1
  }
  if (change.after.kind === 'absent') {
    return change.before.kind === 'directory' ? 4 : 3
  }
  return 2
}

function sortedChanges(changes: ObservedFileChange[]): ObservedFileChange[] {
  return [...changes].sort((left, right) => {
    const rankDiff = applyRank(left) - applyRank(right)
    if (rankDiff !== 0) {
      return rankDiff
    }
    if (left.relativePath < right.relativePath) {
      return -1
    }
    if (left.relativePath > right.relativePath) {
      return 1
    }
    return 0
  })
}

async function applySingleChange(
  sourceRoot: string,
  targetRoot: string,
  change: ObservedFileChange,
): Promise<void> {
  const target = joinRelativePath(targetRoot, change.relativePath)
  if (change.after.kind === 'absent') {
    if (change.before.kind === 'directory') {
      await rmdir(target)
      return
    }
    await rm(target, { force: true })
    return
  }

  await assertParentDirectory(target)
  if (change.after.kind === 'directory') {
    await mkdir(target, { recursive: true, mode: change.after.mode & 0o777 })
    return
  }

  const source = joinRelativePath(sourceRoot, change.relativePath)
  await copyPathPreservingType(source, target)
}

export async function applyObservedChanges(params: ApplyObservedChangesParams): Promise<void> {
  const { sourceRoot, targetRoot, changes } = params
  for (const change of changes) {
    validateRelativePath(change.relativePath)
  }

  for (const change of changes) {
    await assertTargetMatches(targetRoot, change)
  }

  const backupRoot = await mkdtemp(path.join(os.tmpdir(), 'belay-tx-rollback-'))
  const rollbackActions: ApplyRollbackAction[] = []

  try {
    for (const change of sortedChanges(changes)) {
      const target = joinRelativePath(targetRoot, change.relativePath)
      let targetExists = true
      try {
        await lstat(target)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          throw error
        }
        targetExists = false
      }

      if (targetExists) {
        const backupPath = path.join(backupRoot, change.relativePath)
        await mkdir(path.dirname(backupPath), { recursive: true })
        await copyPathPreservingType(target, backupPath)
        rollbackActions.push({ type: 'restore', target, backupPath })
      } else if (change.after.kind !== 'absent') {
        rollbackActions.push({ type: 'remove', target })
      }

      await applySingleChange(sourceRoot, targetRoot, change)
    }

    for (const change of changes) {
      await assertTargetMatchesAfter(targetRoot, change)
    }

    try {
      await params.afterApply?.()
    } catch {
      // Cleanup/audit failure after a verified apply must not roll back or reject success.
    }
  } catch (error) {
    await rollbackAppliedChanges(rollbackActions)
    throw error
  } finally {
    await rm(backupRoot, { recursive: true, force: true })
  }
}

export async function buildObservedChangesFromTransactional(
  baselineRoot: string,
  executionRoot: string,
  changes: TransactionalFileChange[],
): Promise<ObservedFileChange[]> {
  const observed: ObservedFileChange[] = []
  for (const change of changes) {
    validateRelativePath(change.relativePath)
    const before = await readSnapshotNode(joinRelativePath(baselineRoot, change.relativePath))
    const after = await readSnapshotNode(joinRelativePath(executionRoot, change.relativePath))
    observed.push({
      relativePath: change.relativePath,
      kind: change.kind,
      before,
      after,
    })
  }
  return observed
}

export async function snapshotNodeHashMap(
  root: string,
  changes: TransactionalFileChange[],
): Promise<Map<string, SnapshotNode>> {
  const nodes = new Map<string, SnapshotNode>()
  for (const change of changes) {
    nodes.set(
      change.relativePath,
      await readSnapshotNode(joinRelativePath(root, change.relativePath)),
    )
  }
  return nodes
}
