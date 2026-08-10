import path from 'node:path'

import { canonicalPath, pathWithinRoot } from '../path-utils.js'
import type { BoundaryWorkspaceMount } from './boundary-run.js'

const HOST_PATH_ENV_VARS = [
  'BELAY_EGRESS_REPO_ROOT',
  'BELAY_JUDGE_BROKER_REPO_ROOT',
  'BELAY_JUDGE_BROKER_STATE_DIR',
  'BELAY_REPO_ROOT',
] as const

export function validateWorkspaceMount(mount: BoundaryWorkspaceMount): void {
  const hostSourceRoot = canonicalPath(mount.hostSourceRoot)
  const guestTargetRoot = canonicalPath(mount.guestTargetRoot)
  if (!hostSourceRoot || !guestTargetRoot) {
    throw new Error('boundary_workspace_mount_invalid_root')
  }
  if (hostSourceRoot.includes(',') || guestTargetRoot.includes(',')) {
    throw new Error('boundary_workspace_mount_invalid_root')
  }
  if (hostSourceRoot === guestTargetRoot) {
    throw new Error('boundary_workspace_mount_source_equals_target')
  }
  if (pathWithinRoot(hostSourceRoot, guestTargetRoot)) {
    throw new Error('boundary_workspace_mount_source_contains_target')
  }
  if (mount.cwdRelative.includes('\0')) {
    throw new Error('boundary_workspace_mount_invalid_cwd')
  }
  const normalizedRelative = path.posix.normalize(mount.cwdRelative.replace(/\\/g, '/'))
  if (normalizedRelative === '..' || normalizedRelative.startsWith('../')) {
    throw new Error('boundary_workspace_mount_invalid_cwd')
  }
  if (path.posix.isAbsolute(normalizedRelative)) {
    throw new Error('boundary_workspace_mount_invalid_cwd')
  }
}

export function resolveGuestWorkdir(mount: BoundaryWorkspaceMount): string {
  validateWorkspaceMount(mount)
  const guestTargetRoot = canonicalPath(mount.guestTargetRoot)
  const normalizedRelative = path.posix.normalize(mount.cwdRelative.replace(/\\/g, '/'))
  if (normalizedRelative === '.' || normalizedRelative === '') {
    return guestTargetRoot
  }
  const segments = normalizedRelative.split('/').filter(Boolean)
  return path.posix.join(guestTargetRoot, ...segments)
}

export function buildWorkspaceMountSpec(mount: BoundaryWorkspaceMount): string {
  validateWorkspaceMount(mount)
  const hostSourceRoot = canonicalPath(mount.hostSourceRoot)
  const guestTargetRoot = canonicalPath(mount.guestTargetRoot)
  const readonly = mount.writable ? '' : ',readonly'
  return `type=bind,src=${hostSourceRoot},dst=${guestTargetRoot}${readonly}`
}

export function workspaceMountEnvArgs(mount: BoundaryWorkspaceMount): string[] {
  const workdir = resolveGuestWorkdir(mount)
  if (!mount.hideHostSourcePath) {
    return ['-e', `PWD=${workdir}`]
  }

  const guestTargetRoot = canonicalPath(mount.guestTargetRoot)
  const hostSourceRoot = canonicalPath(mount.hostSourceRoot)
  const args: string[] = []
  for (const key of HOST_PATH_ENV_VARS) {
    args.push('-e', `${key}=`)
  }
  args.push(
    '-e',
    `PWD=${workdir}`,
    '-e',
    `OLDPWD=${workdir}`,
    '-e',
    `BELAY_REPO_ROOT=${guestTargetRoot}`,
  )
  if (hostSourceRoot !== guestTargetRoot) {
    args.push('-e', `BELAY_EGRESS_REPO_ROOT=${guestTargetRoot}`)
  }
  return args
}
