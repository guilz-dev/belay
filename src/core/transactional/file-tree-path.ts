import path from 'node:path'

import { canonicalPath, isPathOutsideRoot, pathWithinRoot } from '../path-utils.js'

export const FILE_CHECKPOINT_PATH_ESCAPE = 'file_checkpoint_path_escape'

export function validateRelativePath(relativePath: string): void {
  if (!relativePath || relativePath.includes('\0')) {
    throw new Error(FILE_CHECKPOINT_PATH_ESCAPE)
  }
  if (path.isAbsolute(relativePath)) {
    throw new Error(FILE_CHECKPOINT_PATH_ESCAPE)
  }
  if (isPathOutsideRoot(relativePath)) {
    throw new Error(FILE_CHECKPOINT_PATH_ESCAPE)
  }
  const normalized = path.normalize(relativePath)
  if (normalized === '..' || normalized.startsWith(`..${path.sep}`)) {
    throw new Error(FILE_CHECKPOINT_PATH_ESCAPE)
  }
}

export function joinRelativePath(root: string, relativePath: string): string {
  validateRelativePath(relativePath)
  return path.join(canonicalPath(root), relativePath)
}

export function isRootGitMetadataPath(relativePath: string): boolean {
  return relativePath === '.git' || relativePath.startsWith(`.git${path.sep}`)
}

export function isNestedGitPath(relativePath: string): boolean {
  const segments = relativePath.split(path.sep).filter(Boolean)
  if (segments.length === 0) {
    return false
  }
  if (segments[0] === '.git') {
    return false
  }
  return segments.includes('.git')
}

export function isExcludedTreePath(
  relativePath: string,
  excludedRoots: string[],
  resourceRoot: string,
): boolean {
  if (isRootGitMetadataPath(relativePath)) {
    return true
  }
  if (excludedRoots.length === 0) {
    return false
  }
  const absolutePath = joinRelativePath(resourceRoot, relativePath)
  return excludedRoots.some(
    (root) =>
      pathWithinRoot(root, absolutePath) ||
      root === absolutePath ||
      pathWithinRoot(absolutePath, root),
  )
}

export function compareRelativePathsBytewise(left: string, right: string): number {
  if (left < right) {
    return -1
  }
  if (left > right) {
    return 1
  }
  return 0
}
