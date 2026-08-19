import path from 'node:path'

import type { ContainedExecutionResourceLimits } from '../capability/attestation.js'
import { type ContainedExecutionFailureCode, ContainedExecutionFailureError } from './failure.js'

export const TMPFS_SIZE_BYTES = 64 * 1024 * 1024
export const SHM_SIZE_MIB = 64
export const TMPFS_OPTIONS = `rw,nosuid,nodev,noexec,size=${TMPFS_SIZE_BYTES},mode=1777`
export const PROXY_ENV_NAMES = [
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'ALL_PROXY',
  'NO_PROXY',
  'http_proxy',
  'https_proxy',
  'all_proxy',
  'no_proxy',
] as const
export const IMAGE_ID_PATTERN = /^sha256:[a-f0-9]{64}$/

const SAFE_CONTAINER_NAME = /^belay-contained-[0-9a-f-]{36}$/

function assertSafeDockerPath(value: string, code: ContainedExecutionFailureCode): void {
  if (!path.isAbsolute(value) || /[\0\n\r,]/.test(value)) {
    throw new ContainedExecutionFailureError(code)
  }
}

export function assertContainedExecutionResourceLimits(
  limits: ContainedExecutionResourceLimits,
): void {
  if (
    !Number.isSafeInteger(limits.timeoutMs) ||
    limits.timeoutMs <= 0 ||
    !Number.isSafeInteger(limits.memoryMiB) ||
    limits.memoryMiB <= 0 ||
    !Number.isFinite(limits.cpus) ||
    limits.cpus <= 0 ||
    !Number.isSafeInteger(limits.pids) ||
    limits.pids <= 0
  ) {
    throw new ContainedExecutionFailureError('contained_execution_resource_limits_invalid')
  }
}

export interface BuildContainedDockerCreateArgsParams {
  containerName: string
  imageId: string
  command: string
  hostMirrorRoot: string
  guestWorkspacePath: string
  guestCwd: string
  resourceLimits: ContainedExecutionResourceLimits
  user: string
}

export function buildContainedDockerCreateArgs(
  params: BuildContainedDockerCreateArgsParams,
): string[] {
  if (!IMAGE_ID_PATTERN.test(params.imageId)) {
    throw new ContainedExecutionFailureError('contained_execution_invalid_image_id')
  }
  if (!SAFE_CONTAINER_NAME.test(params.containerName)) {
    throw new ContainedExecutionFailureError('contained_execution_invalid_container_name')
  }
  assertSafeDockerPath(params.hostMirrorRoot, 'contained_execution_invalid_mount')
  assertSafeDockerPath(params.guestWorkspacePath, 'contained_execution_invalid_mount')
  assertSafeDockerPath(params.guestCwd, 'contained_execution_invalid_cwd')
  assertContainedExecutionResourceLimits(params.resourceLimits)
  if (!/^\d+:\d+$/.test(params.user)) {
    throw new ContainedExecutionFailureError('contained_execution_invalid_user')
  }
  const memory = `${params.resourceLimits.memoryMiB}m`
  return [
    'create',
    '--name',
    params.containerName,
    '--network',
    'none',
    '--read-only',
    '--tmpfs',
    `/tmp:${TMPFS_OPTIONS}`,
    '--cap-drop',
    'ALL',
    '--security-opt',
    'no-new-privileges',
    '--log-driver',
    'none',
    '--privileged=false',
    '--publish-all=false',
    '--restart',
    'no',
    '--memory',
    memory,
    '--memory-swap',
    memory,
    '--shm-size',
    `${SHM_SIZE_MIB}m`,
    '--cpus',
    String(params.resourceLimits.cpus),
    '--pids-limit',
    String(params.resourceLimits.pids),
    '--user',
    params.user,
    '--no-healthcheck',
    '--ipc',
    'none',
    '--cgroupns',
    'private',
    ...PROXY_ENV_NAMES.flatMap((name) => ['--env', `${name}=`]),
    '--mount',
    `type=bind,src=${params.hostMirrorRoot},dst=${params.guestWorkspacePath}`,
    '--workdir',
    params.guestCwd,
    '--entrypoint',
    '/bin/sh',
    params.imageId,
    '-c',
    params.command,
  ]
}
