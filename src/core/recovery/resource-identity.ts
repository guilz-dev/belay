import { lstat, readFile, realpath } from 'node:fs/promises'
import path from 'node:path'

import { hashValue } from '../fingerprint.js'
import type { RecoveryCheckpointManifest } from './types.js'

export type RecoveryResourceKind = 'git_repository' | 'directory'

export async function currentRecoveryResourceIdentity(
  resourceRoot: string,
  resourceKind: RecoveryResourceKind,
): Promise<string> {
  const resolvedRoot = await realpath(resourceRoot)
  if (resourceKind === 'directory') {
    const rootInfo = await lstat(resolvedRoot)
    if (!rootInfo.isDirectory()) throw new Error('recovery_repo_identity_unavailable')
    return hashValue(`${resolvedRoot}\0${rootInfo.dev}:${rootInfo.ino}:${rootInfo.birthtimeMs}`)
  }

  const dotGit = path.join(resolvedRoot, '.git')
  const gitInfo = await lstat(dotGit)
  let gitMetadataPath = dotGit
  if (gitInfo.isFile()) {
    const marker = (await readFile(dotGit, 'utf8')).trim()
    if (!marker.startsWith('gitdir:')) throw new Error('recovery_repo_identity_unavailable')
    gitMetadataPath = path.resolve(resolvedRoot, marker.slice('gitdir:'.length).trim())
  } else if (!gitInfo.isDirectory()) {
    throw new Error('recovery_repo_identity_unavailable')
  }
  const resolvedGitMetadataPath = await realpath(gitMetadataPath)
  const metadata = await lstat(resolvedGitMetadataPath)
  return hashValue(
    `${resolvedRoot}\0${resolvedGitMetadataPath}\0${metadata.dev}:${metadata.ino}:${metadata.birthtimeMs}`,
  )
}

export async function assertRecoveryResourceIdentity(
  manifest: RecoveryCheckpointManifest,
): Promise<void> {
  const resourceKind = manifest.version === 1 ? 'git_repository' : manifest.resourceKind
  if (
    (await currentRecoveryResourceIdentity(manifest.repoRoot, resourceKind)) !==
    manifest.repoIdentity
  ) {
    throw new Error('recovery_checkpoint_repo_mismatch')
  }
}
