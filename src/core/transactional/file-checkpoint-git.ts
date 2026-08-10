import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFile, readdir, readFile } from 'node:fs/promises'
import path from 'node:path'

import { canonicalPath } from '../path-utils.js'

export const FILE_CHECKPOINT_GIT_METADATA_CHANGED = 'file_checkpoint_git_metadata_changed'
export const FILE_CHECKPOINT_BASELINE_MISMATCH = 'file_checkpoint_baseline_mismatch'
export const FILE_CHECKPOINT_CWD_OUTSIDE_ROOT = 'file_checkpoint_cwd_outside_root'
export const FILE_CHECKPOINT_PREPARE_FAILED = 'file_checkpoint_prepare_failed'

export function execGit(repoRoot: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', ['-C', repoRoot, ...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    child.stdout.on('data', (chunk) => stdout.push(Buffer.from(chunk)))
    child.stderr.on('data', (chunk) => stderr.push(Buffer.from(chunk)))
    child.on('error', reject)
    child.on('close', (code) => {
      if (code === 0) {
        resolve(Buffer.concat(stdout).toString('utf8'))
        return
      }
      reject(
        new Error(
          `git ${args.join(' ')} failed (${code}): ${Buffer.concat(stderr).toString('utf8').trim()}`,
        ),
      )
    })
  })
}

async function resolveGitPath(repoRoot: string, gitPath: string): Promise<string> {
  const trimmed = gitPath.trim()
  if (path.isAbsolute(trimmed)) {
    return trimmed
  }
  return path.join(repoRoot, trimmed)
}

export async function cloneBareWorktreeCopy(
  sourceRoot: string,
  destinationRoot: string,
): Promise<void> {
  await execGit(sourceRoot, [
    'clone',
    '--local',
    '--no-hardlinks',
    '--no-checkout',
    sourceRoot,
    destinationRoot,
  ])
}

export async function removeAllGitRemotes(repoRoot: string): Promise<void> {
  const remotes = (await execGit(repoRoot, ['remote']))
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
  for (const remote of remotes) {
    await execGit(repoRoot, ['remote', 'remove', remote])
  }
}

export async function copyGitIndexState(
  sourceRoot: string,
  destinationRoot: string,
): Promise<void> {
  const sourceIndex = await resolveGitPath(
    sourceRoot,
    await execGit(sourceRoot, ['rev-parse', '--git-path', 'index']),
  )
  const destinationIndex = await resolveGitPath(
    destinationRoot,
    await execGit(destinationRoot, ['rev-parse', '--git-path', 'index']),
  )
  await copyFile(sourceIndex, destinationIndex)

  try {
    const sharedIndex = (await execGit(sourceRoot, ['rev-parse', '--shared-index-path'])).trim()
    if (!sharedIndex) {
      return
    }
    const sourceShared = await resolveGitPath(sourceRoot, sharedIndex)
    const destinationShared = await resolveGitPath(destinationRoot, sharedIndex)
    if (canonicalPath(sourceShared) === canonicalPath(sourceIndex)) {
      return
    }
    await copyFile(sourceShared, destinationShared)
  } catch {
    // Split index unsupported or unavailable — index copy alone is sufficient.
  }
}

async function readGitFile(gitDir: string, relativePath: string): Promise<string | null> {
  try {
    return await readFile(path.join(gitDir, relativePath), 'utf8')
  } catch {
    return null
  }
}

async function hashGitTree(
  gitDir: string,
  relativeDir: string,
  hash: ReturnType<typeof createHash>,
): Promise<void> {
  let names: string[]
  try {
    names = await readdir(path.join(gitDir, relativeDir))
  } catch {
    return
  }
  for (const name of names.sort()) {
    const relativePath = relativeDir ? path.join(relativeDir, name) : name
    const absolutePath = path.join(gitDir, relativePath)
    let childNames: string[] | null = null
    try {
      childNames = await readdir(absolutePath)
    } catch {
      childNames = null
    }
    if (childNames) {
      await hashGitTree(gitDir, relativePath, hash)
      continue
    }
    const content = await readGitFile(gitDir, relativePath)
    if (content !== null) {
      hash.update(relativePath.replace(/\\/g, '/'))
      hash.update('\0')
      hash.update(content)
      hash.update('\0')
    }
  }
}

export async function computeGitMetadataFingerprint(repoRoot: string): Promise<string> {
  const gitDirRel = (await execGit(repoRoot, ['rev-parse', '--git-dir'])).trim()
  const gitDir = path.isAbsolute(gitDirRel) ? gitDirRel : path.join(repoRoot, gitDirRel)
  const hash = createHash('sha256')

  for (const file of [
    'HEAD',
    'config',
    'index',
    'packed-refs',
    'COMMIT_EDITMSG',
    'MERGE_HEAD',
    'CHERRY_PICK_HEAD',
  ]) {
    const content = await readGitFile(gitDir, file)
    if (content !== null) {
      hash.update(file)
      hash.update('\0')
      hash.update(content)
      hash.update('\0')
    }
  }

  await hashGitTree(gitDir, 'refs', hash)
  return hash.digest('hex')
}

export function resolveExecutionCwdRelative(resourceRoot: string, cwd: string): string {
  const resolvedCwd = canonicalPath(cwd)
  const resourceCanonical = canonicalPath(resourceRoot)
  const relative = path.relative(resourceCanonical, resolvedCwd)
  if (relative === '' || relative === '.') {
    return ''
  }
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(FILE_CHECKPOINT_CWD_OUTSIDE_ROOT)
  }
  return relative.split(path.sep).join('/')
}
