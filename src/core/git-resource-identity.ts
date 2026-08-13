import { lstatSync, readFileSync, realpathSync, statSync } from 'node:fs'
import path from 'node:path'

export interface GitResourceIdentity {
  repositoryRoot: string
  gitDir: string
  commonDir: string
  gitEntryPath: string
}

export type GitResourceIdentityInspection =
  | { status: 'resolved'; identity: GitResourceIdentity }
  | { status: 'absent' }
  | { status: 'invalid'; boundaryPath: string; metadataRoots: string[] }

function canonicalExistingPath(targetPath: string): string | null {
  try {
    return realpathSync.native(targetPath)
  } catch {
    return null
  }
}

function isDirectory(targetPath: string): boolean {
  try {
    return statSync(targetPath).isDirectory()
  } catch {
    return false
  }
}

function nearestExistingDirectory(
  targetPath: string,
): { status: 'resolved'; directory: string } | { status: 'invalid' } {
  let current = path.resolve(targetPath)

  while (true) {
    try {
      const stats = statSync(current)
      const directory = stats.isDirectory() ? current : path.dirname(current)
      const canonical = canonicalExistingPath(directory)
      return canonical ? { status: 'resolved', directory: canonical } : { status: 'invalid' }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code !== 'ENOENT' && code !== 'ENOTDIR') {
        return { status: 'invalid' }
      }
    }

    const parent = path.dirname(current)
    if (parent === current) {
      return { status: 'invalid' }
    }
    current = parent
  }
}

function readSingleMetadataLine(metadataPath: string): string | null {
  try {
    const value = readFileSync(metadataPath, 'utf8').trim()
    if (!value || value.includes('\0') || value.includes('\n') || value.includes('\r')) {
      return null
    }
    return value
  } catch {
    return null
  }
}

function pathEntryStatus(targetPath: string): 'present' | 'absent' | 'unreadable' {
  try {
    lstatSync(targetPath)
    return 'present'
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return 'absent'
    }
    return 'unreadable'
  }
}

function resolveMetadataDirectory(value: string, baseDirectory: string): string | null {
  const candidate = path.isAbsolute(value) ? value : path.resolve(baseDirectory, value)
  if (!isDirectory(candidate)) {
    return null
  }
  return canonicalExistingPath(candidate)
}

function hasValidCommonDirStructure(commonDir: string): boolean {
  return (
    hasValidHead(commonDir) &&
    hasValidGitConfig(commonDir) &&
    isDirectory(path.join(commonDir, 'objects')) &&
    isDirectory(path.join(commonDir, 'refs'))
  )
}

function hasValidHead(gitDir: string): boolean {
  const head = readSingleMetadataLine(path.join(gitDir, 'HEAD'))
  return head !== null && (/^ref:\s+refs\/\S+$/.test(head) || /^[0-9a-f]{40,64}$/i.test(head))
}

function hasValidGitConfig(gitDir: string): boolean {
  const configPath = path.join(gitDir, 'config')
  try {
    return (
      statSync(configPath).isFile() && /^\s*\[core\]\s*$/im.test(readFileSync(configPath, 'utf8'))
    )
  } catch {
    return false
  }
}

function looksLikeBareBoundary(candidate: string): boolean {
  const markers = [
    pathEntryStatus(path.join(candidate, 'HEAD')),
    pathEntryStatus(path.join(candidate, 'config')),
    pathEntryStatus(path.join(candidate, 'objects')),
    pathEntryStatus(path.join(candidate, 'refs')),
  ]
  return markers.filter((status) => status !== 'absent').length >= 2
}

function invalidInspection(
  boundaryPath: string,
  metadataRoots: string[],
): GitResourceIdentityInspection {
  return {
    status: 'invalid',
    boundaryPath,
    metadataRoots: [...new Set(metadataRoots.map((root) => path.resolve(root)))],
  }
}

function resolveBareIdentity(repositoryRoot: string): GitResourceIdentityInspection | null {
  if (!looksLikeBareBoundary(repositoryRoot)) {
    return null
  }
  if (!hasValidCommonDirStructure(repositoryRoot)) {
    return invalidInspection(repositoryRoot, [repositoryRoot])
  }
  return {
    status: 'resolved',
    identity: {
      repositoryRoot,
      gitDir: repositoryRoot,
      commonDir: repositoryRoot,
      gitEntryPath: repositoryRoot,
    },
  }
}

function resolveLinkedIdentity(
  repositoryRoot: string,
  gitEntryPath: string,
): GitResourceIdentityInspection {
  const forwardMetadata = readSingleMetadataLine(gitEntryPath)
  const match = forwardMetadata?.match(/^gitdir:\s*(.+)$/)
  const gitDirValue = match?.[1]?.trim()
  if (!gitDirValue) {
    return invalidInspection(repositoryRoot, [gitEntryPath])
  }
  const gitDir = resolveMetadataDirectory(gitDirValue, repositoryRoot)
  if (!gitDir) {
    return invalidInspection(repositoryRoot, [gitEntryPath])
  }

  const commonDirValue = readSingleMetadataLine(path.join(gitDir, 'commondir'))
  const commonDir = commonDirValue ? resolveMetadataDirectory(commonDirValue, gitDir) : null
  const backpointerValue = readSingleMetadataLine(path.join(gitDir, 'gitdir'))
  const backpointer = backpointerValue
    ? canonicalExistingPath(
        path.isAbsolute(backpointerValue)
          ? backpointerValue
          : path.resolve(gitDir, backpointerValue),
      )
    : null
  const canonicalGitEntry = canonicalExistingPath(gitEntryPath)
  const expectedWorktreesRoot = commonDir ? path.join(commonDir, 'worktrees') : null
  const linkedStructureValid =
    hasValidHead(gitDir) &&
    commonDir !== null &&
    hasValidCommonDirStructure(commonDir) &&
    expectedWorktreesRoot !== null &&
    path.dirname(gitDir) === expectedWorktreesRoot &&
    backpointer !== null &&
    canonicalGitEntry !== null &&
    backpointer === canonicalGitEntry

  if (!linkedStructureValid || !commonDir || !canonicalGitEntry) {
    return invalidInspection(repositoryRoot, [
      gitEntryPath,
      gitDir,
      ...(commonDir ? [commonDir] : []),
    ])
  }
  return {
    status: 'resolved',
    identity: {
      repositoryRoot,
      gitDir,
      commonDir,
      gitEntryPath: canonicalGitEntry,
    },
  }
}

function inspectWorktreeBoundary(repositoryRoot: string): GitResourceIdentityInspection | null {
  const gitEntryPath = path.join(repositoryRoot, '.git')
  const entryStatus = pathEntryStatus(gitEntryPath)
  if (entryStatus === 'absent') {
    return null
  }
  if (entryStatus === 'unreadable') {
    return invalidInspection(repositoryRoot, [gitEntryPath])
  }

  try {
    if (lstatSync(gitEntryPath).isSymbolicLink()) {
      return invalidInspection(repositoryRoot, [gitEntryPath])
    }
    const entryStats = statSync(gitEntryPath)
    if (entryStats.isFile()) {
      return resolveLinkedIdentity(repositoryRoot, gitEntryPath)
    }
    if (!entryStats.isDirectory()) {
      return invalidInspection(repositoryRoot, [gitEntryPath])
    }
  } catch {
    return invalidInspection(repositoryRoot, [gitEntryPath])
  }

  const gitDir = canonicalExistingPath(gitEntryPath)
  const canonicalGitEntry = canonicalExistingPath(gitEntryPath)
  if (!gitDir || !canonicalGitEntry || !hasValidCommonDirStructure(gitDir)) {
    return invalidInspection(repositoryRoot, [gitEntryPath])
  }
  return {
    status: 'resolved',
    identity: {
      repositoryRoot,
      gitDir,
      commonDir: gitDir,
      gitEntryPath: canonicalGitEntry,
    },
  }
}

/**
 * Inspects the Git boundary containing a path without executing Git or a shell.
 * Malformed or unreadable metadata is distinct from an absent Git boundary.
 */
export function inspectGitResourceIdentity(targetPath: string): GitResourceIdentityInspection {
  const nearest = nearestExistingDirectory(targetPath)
  if (nearest.status === 'invalid') {
    return invalidInspection(path.resolve(targetPath), [path.resolve(targetPath)])
  }
  let current = nearest.directory

  while (true) {
    const worktree = inspectWorktreeBoundary(current)
    if (worktree) {
      return worktree
    }
    const bare = resolveBareIdentity(current)
    if (bare) {
      return bare
    }

    const parent = path.dirname(current)
    if (parent === current) {
      return { status: 'absent' }
    }
    current = parent
  }
}

/** Resolves only structurally valid Git metadata; otherwise returns null. */
export function resolveGitResourceIdentity(targetPath: string): GitResourceIdentity | null {
  const inspection = inspectGitResourceIdentity(targetPath)
  return inspection.status === 'resolved' ? inspection.identity : null
}

export function sameGitResourceIdentity(leftPath: string, rightPath: string): boolean {
  const left = resolveGitResourceIdentity(leftPath)
  const right = resolveGitResourceIdentity(rightPath)
  return left !== null && right !== null && left.commonDir === right.commonDir
}

function canonicalTargetPath(targetPath: string): string {
  const resolved = path.resolve(targetPath)
  let current = resolved
  const suffix: string[] = []

  while (true) {
    const canonical = canonicalExistingPath(current)
    if (canonical) {
      return path.join(canonical, ...suffix)
    }
    const parent = path.dirname(current)
    if (parent === current) {
      return resolved
    }
    suffix.unshift(path.basename(current))
    current = parent
  }
}

function pathWithin(root: string, targetPath: string): boolean {
  const relative = path.relative(root, targetPath)
  return (
    relative === '' ||
    (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`))
  )
}

/** Protects control data for any proven repository and any malformed Git boundary. */
export function isGitMetadataPath(targetPath: string, _repositoryPath?: string): boolean {
  const inspection = inspectGitResourceIdentity(targetPath)
  const target = canonicalTargetPath(targetPath)
  if (inspection.status === 'invalid') {
    return inspection.metadataRoots.some((root) => {
      const canonicalRoot = canonicalTargetPath(root)
      return target === canonicalRoot || pathWithin(canonicalRoot, target)
    })
  }
  if (inspection.status !== 'resolved') {
    return false
  }
  const { identity } = inspection
  return (
    target === identity.gitEntryPath ||
    pathWithin(identity.gitDir, target) ||
    pathWithin(identity.commonDir, target)
  )
}
