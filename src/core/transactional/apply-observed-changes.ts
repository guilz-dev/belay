import { copyFile, lstat, mkdir, mkdtemp, readlink, rm, rmdir, symlink } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { ObservedFileChange } from './file-tree.js'
import {
  compareRelativePathsBytewise,
  joinRelativePath,
  validateRelativePath,
} from './file-tree-path.js'
import { readSnapshotNode, snapshotNodesEqual } from './snapshot-node.js'
import type { TransactionalFileChange } from './types.js'

export const TRANSACTIONAL_APPLY_TOCTOU = 'transactional_apply_toctou'
export const TRANSACTIONAL_APPLY_CONFLICT = 'transactional_apply_conflict'
export const TRANSACTIONAL_APPLY_ROLLBACK_FAILED = 'transactional_apply_rollback_failed'

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

async function removePathIfExists(target: string): Promise<void> {
  let info: Awaited<ReturnType<typeof lstat>>
  try {
    info = await lstat(target)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return
    }
    throw error
  }
  if (info.isDirectory() && !info.isSymbolicLink()) {
    await rm(target, { recursive: true, force: true })
    return
  }
  await rm(target, { force: true })
}

async function copyPathPreservingType(source: string, target: string): Promise<void> {
  const info = await lstat(source)
  await removePathIfExists(target)
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

async function assertParentChainSafe(targetRoot: string, relativePath: string): Promise<void> {
  const segments = relativePath.split(path.sep).filter(Boolean)
  if (segments.length <= 1) {
    return
  }

  for (let index = 1; index < segments.length; index++) {
    const prefix = segments.slice(0, index).join(path.sep)
    const absolute = joinRelativePath(targetRoot, prefix)
    let info: Awaited<ReturnType<typeof lstat>>
    try {
      info = await lstat(absolute)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        continue
      }
      throw error
    }
    if (!info.isDirectory() || info.isSymbolicLink()) {
      throw new Error(TRANSACTIONAL_APPLY_CONFLICT)
    }
  }
}

async function restorePathFromBackup(backupPath: string, target: string): Promise<void> {
  const staged = `${target}.belay-restore.tmp`
  try {
    await copyPathPreservingType(backupPath, staged)
    await removePathIfExists(target)
    const { rename } = await import('node:fs/promises')
    await rename(staged, target)
  } catch (error) {
    await removePathIfExists(staged)
    throw error
  }
}

async function rollbackAppliedChanges(actions: ApplyRollbackAction[]): Promise<boolean> {
  let hadFailure = false
  for (const action of [...actions].reverse()) {
    try {
      if (action.type === 'restore') {
        await restorePathFromBackup(action.backupPath, action.target)
      } else {
        await removePathIfExists(action.target)
      }
    } catch {
      hadFailure = true
    }
  }
  return !hadFailure
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

function compareApplyOrder(left: ObservedFileChange, right: ObservedFileChange): number {
  const leftRank = applyRank(left)
  const rightRank = applyRank(right)
  const rankDiff = leftRank - rightRank
  if (rankDiff !== 0) {
    return rankDiff
  }
  if (leftRank === 4) {
    return compareRelativePathsBytewise(right.relativePath, left.relativePath)
  }
  return compareRelativePathsBytewise(left.relativePath, right.relativePath)
}

function sortedChanges(changes: ObservedFileChange[]): ObservedFileChange[] {
  return [...changes].sort(compareApplyOrder)
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

  await assertParentChainSafe(targetRoot, change.relativePath)
  if (change.after.kind === 'directory') {
    await mkdir(target, { recursive: true, mode: change.after.mode & 0o777 })
    await chmodSafe(target, change.after.mode)
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
    if (change.after.kind !== 'absent') {
      await assertParentChainSafe(targetRoot, change.relativePath)
    }
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
        const backupPath = path.join(
          backupRoot,
          String(rollbackActions.length),
          change.relativePath,
        )
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
    const rollbackOk = await rollbackAppliedChanges(rollbackActions)
    if (!rollbackOk) {
      throw new Error(TRANSACTIONAL_APPLY_ROLLBACK_FAILED)
    }
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
