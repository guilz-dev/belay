import { createHash, randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { access, constants, lstat, mkdtemp, realpath, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import type {
  BoundaryAttestation,
  ContainedExecutionAttestation,
  ContainedExecutionResourceLimits,
  DockerSubstrateIdentity,
} from '../capability/attestation.js'
import { isContainedExecutionAttestationFresh } from '../capability/attestation.js'
import { verifySignedBoundaryAttestation } from '../capability/boundary-attestation-sign.js'
import type { BelayContainedExecutionConfig } from '../config.js'
import { canonicalStringify, hashValue } from '../fingerprint.js'
import { canonicalPath, pathWithinRoot } from '../path-utils.js'
import { runProcessWithBoundedOutput, type ShellRunResult } from '../process-runner.js'
import {
  type ContainedExecutionMirrorBackend,
  type ContainedExecutionMirrorHandle,
  validateContainedExecutionMirrorLease,
} from './mirror.js'

const DOCKER_CONTROL_TIMEOUT_MS = 10_000
const CONTAINED_ATTESTATION_TTL_MS = 15 * 60_000
const TMPFS_SIZE_BYTES = 64 * 1024 * 1024
const SHM_SIZE_MIB = 64
const TMPFS_OPTIONS = `rw,nosuid,nodev,noexec,size=${TMPFS_SIZE_BYTES},mode=1777`
const PROXY_ENV_NAMES = [
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'ALL_PROXY',
  'NO_PROXY',
  'http_proxy',
  'https_proxy',
  'all_proxy',
  'no_proxy',
] as const
const MINIMAL_DOCKER_ENV = Object.freeze({
  DOCKER_CONFIG: '/var/empty/belay-docker-config',
  HOME: '/var/empty',
  LC_ALL: 'C',
  PATH: '/usr/bin:/bin',
})
const IMAGE_ID = /^sha256:[a-f0-9]{64}$/
const CONTAINER_ID = /^[a-f0-9]{64}$/
const SAFE_CONTAINER_NAME = /^belay-contained-[0-9a-f-]{36}$/
const IMAGE_INSPECT_FORMAT = '[{{json .Id}},{{json .Config.Env}}]'
const CONTAINER_INSPECT_FIELDS = [
  '.Id',
  '.Image',
  '.Config.User',
  '.Config.Env',
  '.Config.Entrypoint',
  '.Config.Cmd',
  '.Config.WorkingDir',
  '.Config.Healthcheck',
  '.HostConfig.AutoRemove',
  '.HostConfig.Privileged',
  '.HostConfig.CapAdd',
  '.HostConfig.CapDrop',
  '.HostConfig.SecurityOpt',
  '.HostConfig.LogConfig',
  '.HostConfig.Devices',
  '.HostConfig.DeviceRequests',
  '.HostConfig.DeviceCgroupRules',
  '.HostConfig.GroupAdd',
  '.HostConfig.VolumesFrom',
  '.HostConfig.Binds',
  '.HostConfig.PortBindings',
  '.HostConfig.PublishAllPorts',
  '.HostConfig.Links',
  '.HostConfig.ExtraHosts',
  '.HostConfig.Dns',
  '.HostConfig.DnsOptions',
  '.HostConfig.DnsSearch',
  '.HostConfig.NetworkMode',
  '.HostConfig.ReadonlyRootfs',
  '.HostConfig.Tmpfs',
  '.HostConfig.Memory',
  '.HostConfig.MemorySwap',
  '.HostConfig.ShmSize',
  '.HostConfig.NanoCpus',
  '.HostConfig.PidsLimit',
  '.HostConfig.RestartPolicy',
  '.HostConfig.IpcMode',
  '.HostConfig.PidMode',
  '.HostConfig.UTSMode',
  '.HostConfig.UsernsMode',
  '.HostConfig.CgroupnsMode',
  '.NetworkSettings.Ports',
  '.Mounts',
] as const
const CONTAINER_INSPECT_FORMAT = `[${CONTAINER_INSPECT_FIELDS.map((field) => `{{json ${field}}}`).join(',')}]`

export const CONTAINED_EXECUTION_BOUNDARY_UNAVAILABLE = 'contained_execution_boundary_unavailable'
export const CONTAINED_EXECUTION_CONTAINER_CLEANUP_UNCONFIRMED =
  'contained_execution_container_cleanup_unconfirmed'

export class ContainedDockerBoundaryUnavailableError extends Error {
  readonly code = CONTAINED_EXECUTION_BOUNDARY_UNAVAILABLE
  readonly executionStarted = false
  readonly receipt = undefined

  constructor(
    readonly reason: string,
    options?: ErrorOptions,
  ) {
    super(`${CONTAINED_EXECUTION_BOUNDARY_UNAVAILABLE}: ${reason}`, options)
    this.name = 'ContainedDockerBoundaryUnavailableError'
  }
}

export class ContainedDockerStartAttemptError extends Error {
  readonly code = 'contained_execution_start_attempt_failed'
  readonly executionStarted = true

  constructor(options?: ErrorOptions) {
    super('contained_execution_start_attempt_failed', options)
    this.name = 'ContainedDockerStartAttemptError'
  }
}

export class ContainedDockerCleanupUnconfirmedError extends Error {
  readonly code = CONTAINED_EXECUTION_CONTAINER_CLEANUP_UNCONFIRMED
  readonly cleanupConfirmed = false

  constructor(
    readonly containerName: string,
    readonly executionStarted: boolean,
    options?: ErrorOptions,
  ) {
    super(`${CONTAINED_EXECUTION_CONTAINER_CLEANUP_UNCONFIRMED}: ${containerName}`, options)
    this.name = 'ContainedDockerCleanupUnconfirmedError'
  }
}

export interface ContainedDockerInspect {
  Id: string
  Image: string
  Config: {
    User: string
    Env: string[] | null
    Entrypoint: string[] | string | null
    Cmd: string[] | null
    WorkingDir: string
    Healthcheck: { Test?: string[] | null } | null
  }
  HostConfig: {
    AutoRemove: boolean
    Privileged: boolean
    CapAdd: string[] | null
    CapDrop: string[] | null
    SecurityOpt: string[] | null
    LogConfig: { Type: string; Config: Record<string, string> | null } | null
    Devices: unknown[] | null
    DeviceRequests: unknown[] | null
    DeviceCgroupRules: string[] | null
    GroupAdd: string[] | null
    VolumesFrom: string[] | null
    Binds: string[] | null
    PortBindings: Record<string, unknown> | null
    PublishAllPorts: boolean
    Links: string[] | null
    ExtraHosts: string[] | null
    Dns: string[] | null
    DnsOptions: string[] | null
    DnsSearch: string[] | null
    NetworkMode: string
    ReadonlyRootfs: boolean
    Tmpfs: Record<string, string> | null
    Memory: number
    MemorySwap: number
    ShmSize: number
    NanoCpus: number
    PidsLimit: number | null
    RestartPolicy: { Name: string; MaximumRetryCount: number }
    IpcMode: string
    PidMode: string
    UTSMode: string
    UsernsMode: string
    CgroupnsMode: string
  }
  NetworkSettings: { Ports: Record<string, unknown> | null }
  Mounts: Array<{ Type: string; Source: string; Destination: string; RW: boolean }>
}

export interface ContainedDockerDependencies {
  resolveSubstrate(params: {
    executable: string
    host: string
    repoRoot: string
    protectedRoots: readonly string[]
  }): Promise<DockerSubstrateIdentity>
  runProcess(
    file: string,
    args: string[],
    env: Record<string, string>,
    timeoutMs: number,
  ): Promise<ShellRunResult>
  now(): number
  randomUUID(): string
  uid(): number
  gid(): number
}

function overlaps(candidate: string, root: string): boolean {
  return pathWithinRoot(root, candidate) || pathWithinRoot(candidate, root)
}

async function digestFile(file: string): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(file)) hash.update(chunk)
  return hash.digest('hex')
}

async function resolveConfiguredDockerSubstrate(params: {
  executable: string
  host: string
  repoRoot: string
  protectedRoots: readonly string[]
}): Promise<DockerSubstrateIdentity> {
  if (!path.isAbsolute(params.executable) || /[\0\n\r]/.test(params.executable)) {
    throw new ContainedDockerBoundaryUnavailableError('contained_execution_docker_binary_invalid')
  }
  if (!params.host.startsWith('unix:///') || /[\0\n\r]/.test(params.host)) {
    throw new ContainedDockerBoundaryUnavailableError('contained_execution_docker_host_invalid')
  }
  const configuredSocket = params.host.slice('unix://'.length)
  if (!path.isAbsolute(configuredSocket)) {
    throw new ContainedDockerBoundaryUnavailableError('contained_execution_docker_host_invalid')
  }

  let binaryPath: string
  let socketPath: string
  try {
    await access(params.executable, constants.X_OK)
    ;[binaryPath, socketPath] = await Promise.all([
      realpath(params.executable),
      realpath(configuredSocket),
    ])
    const [binaryInfo, socketInfo] = await Promise.all([lstat(binaryPath), lstat(socketPath)])
    if (!binaryInfo.isFile() || binaryInfo.isSymbolicLink() || !socketInfo.isSocket()) {
      throw new Error('invalid Docker substrate type')
    }
  } catch (error) {
    throw new ContainedDockerBoundaryUnavailableError(
      'contained_execution_docker_substrate_unavailable',
      { cause: error },
    )
  }
  const excluded = [params.repoRoot, ...params.protectedRoots].map(canonicalPath)
  if (excluded.some((root) => overlaps(binaryPath, root) || overlaps(socketPath, root))) {
    throw new ContainedDockerBoundaryUnavailableError(
      'contained_execution_docker_substrate_overlap',
    )
  }
  const endpoint = `unix://${socketPath}`
  const info = await runProcessWithBoundedOutput(
    binaryPath,
    ['--host', endpoint, 'info', '--format', '{{json .ID}}'],
    { env: { ...MINIMAL_DOCKER_ENV }, argv0: 'docker' },
    DOCKER_CONTROL_TIMEOUT_MS,
  )
  if (info.timedOut || info.exitCode !== 0) {
    throw new ContainedDockerBoundaryUnavailableError(
      'contained_execution_docker_daemon_unavailable',
    )
  }
  let daemonId: unknown
  try {
    daemonId = JSON.parse(info.stdout.trim())
  } catch (error) {
    throw new ContainedDockerBoundaryUnavailableError('contained_execution_docker_daemon_invalid', {
      cause: error,
    })
  }
  if (typeof daemonId !== 'string' || !daemonId || /[\0\n\r]/.test(daemonId)) {
    throw new ContainedDockerBoundaryUnavailableError('contained_execution_docker_daemon_invalid')
  }
  return { binaryPath, binarySha256: await digestFile(binaryPath), endpoint, daemonId }
}

const productionDependencies: ContainedDockerDependencies = {
  resolveSubstrate: resolveConfiguredDockerSubstrate,
  runProcess: (file, args, env, timeoutMs) =>
    runProcessWithBoundedOutput(file, args, { env, argv0: 'docker' }, timeoutMs),
  now: () => Date.now(),
  randomUUID,
  uid: () => {
    if (!process.getuid) throw new Error('contained_execution_host_identity_unavailable')
    return process.getuid()
  },
  gid: () => {
    if (!process.getgid) throw new Error('contained_execution_host_identity_unavailable')
    return process.getgid()
  },
}

function dockerCall(
  dependencies: ContainedDockerDependencies,
  substrate: DockerSubstrateIdentity,
  args: string[],
  timeoutMs: number,
): Promise<ShellRunResult> {
  return dependencies.runProcess(
    substrate.binaryPath,
    ['--host', substrate.endpoint, ...args],
    { ...MINIMAL_DOCKER_ENV },
    timeoutMs,
  )
}

function assertSafeDockerPath(value: string, code: string): void {
  if (!path.isAbsolute(value) || /[\0\n\r,]/.test(value)) throw new Error(code)
}

function assertResourceLimits(limits: ContainedExecutionResourceLimits): void {
  if (
    !Number.isSafeInteger(limits.timeoutMs) ||
    limits.timeoutMs <= 0 ||
    !Number.isSafeInteger(limits.memoryMiB) ||
    limits.memoryMiB <= 0 ||
    !Number.isFinite(limits.cpus) ||
    limits.cpus <= 0 ||
    !Number.isSafeInteger(limits.pids) ||
    limits.pids <= 0
  )
    throw new Error('contained_execution_resource_limits_invalid')
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
  if (!IMAGE_ID.test(params.imageId)) throw new Error('contained_execution_invalid_image_id')
  if (!SAFE_CONTAINER_NAME.test(params.containerName)) {
    throw new Error('contained_execution_invalid_container_name')
  }
  assertSafeDockerPath(params.hostMirrorRoot, 'contained_execution_invalid_mount')
  assertSafeDockerPath(params.guestWorkspacePath, 'contained_execution_invalid_mount')
  assertSafeDockerPath(params.guestCwd, 'contained_execution_invalid_cwd')
  assertResourceLimits(params.resourceLimits)
  if (!/^\d+:\d+$/.test(params.user)) throw new Error('contained_execution_invalid_user')
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

function parseFormattedInspect(
  result: ShellRunResult,
  expectedLength: number,
  code: string,
): unknown[] {
  if (result.stdoutTruncated) {
    throw new ContainedDockerBoundaryUnavailableError(`${code}_truncated`)
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(result.stdout)
  } catch {
    throw new ContainedDockerBoundaryUnavailableError(`${code}_invalid`)
  }
  if (!Array.isArray(parsed) || parsed.length !== expectedLength) {
    throw new ContainedDockerBoundaryUnavailableError(`${code}_invalid`)
  }
  return parsed
}

function parseContainerInspect(result: ShellRunResult, code: string): ContainedDockerInspect {
  const v = parseFormattedInspect(result, CONTAINER_INSPECT_FIELDS.length, code)
  return {
    Id: v[0] as string,
    Image: v[1] as string,
    Config: {
      User: v[2] as string,
      Env: v[3] as string[] | null,
      Entrypoint: v[4] as string[] | string | null,
      Cmd: v[5] as string[] | null,
      WorkingDir: v[6] as string,
      Healthcheck: v[7] as { Test?: string[] | null } | null,
    },
    HostConfig: {
      AutoRemove: v[8] as boolean,
      Privileged: v[9] as boolean,
      CapAdd: v[10] as string[] | null,
      CapDrop: v[11] as string[] | null,
      SecurityOpt: v[12] as string[] | null,
      LogConfig: v[13] as { Type: string; Config: Record<string, string> | null } | null,
      Devices: v[14] as unknown[] | null,
      DeviceRequests: v[15] as unknown[] | null,
      DeviceCgroupRules: v[16] as string[] | null,
      GroupAdd: v[17] as string[] | null,
      VolumesFrom: v[18] as string[] | null,
      Binds: v[19] as string[] | null,
      PortBindings: v[20] as Record<string, unknown> | null,
      PublishAllPorts: v[21] as boolean,
      Links: v[22] as string[] | null,
      ExtraHosts: v[23] as string[] | null,
      Dns: v[24] as string[] | null,
      DnsOptions: v[25] as string[] | null,
      DnsSearch: v[26] as string[] | null,
      NetworkMode: v[27] as string,
      ReadonlyRootfs: v[28] as boolean,
      Tmpfs: v[29] as Record<string, string> | null,
      Memory: v[30] as number,
      MemorySwap: v[31] as number,
      ShmSize: v[32] as number,
      NanoCpus: v[33] as number,
      PidsLimit: v[34] as number | null,
      RestartPolicy: v[35] as { Name: string; MaximumRetryCount: number },
      IpcMode: v[36] as string,
      PidMode: v[37] as string,
      UTSMode: v[38] as string,
      UsernsMode: v[39] as string,
      CgroupnsMode: v[40] as string,
    },
    NetworkSettings: { Ports: v[41] as Record<string, unknown> | null },
    Mounts: v[42] as ContainedDockerInspect['Mounts'],
  }
}

interface LocalImage {
  imageId: string
  environment: string[]
}

async function resolveLocalImage(
  reference: string,
  dependencies: ContainedDockerDependencies,
  substrate: DockerSubstrateIdentity,
): Promise<LocalImage> {
  if (!reference.trim() || /[\0\n\r]/.test(reference)) {
    throw new ContainedDockerBoundaryUnavailableError('contained_execution_image_missing')
  }
  const inspected = await dockerCall(
    dependencies,
    substrate,
    ['image', 'inspect', '--format', IMAGE_INSPECT_FORMAT, reference],
    DOCKER_CONTROL_TIMEOUT_MS,
  )
  if (inspected.timedOut || inspected.exitCode !== 0) {
    throw new ContainedDockerBoundaryUnavailableError('contained_execution_image_missing')
  }
  const [inspectedId, inspectedEnvironment] = parseFormattedInspect(
    inspected,
    2,
    'contained_execution_image_inspect',
  )
  if (
    typeof inspectedId !== 'string' ||
    !IMAGE_ID.test(inspectedId) ||
    (inspectedEnvironment != null &&
      (!Array.isArray(inspectedEnvironment) ||
        !inspectedEnvironment.every((entry) => typeof entry === 'string')))
  )
    throw new ContainedDockerBoundaryUnavailableError('contained_execution_image_inspect_invalid')
  return {
    imageId: inspectedId,
    environment: (inspectedEnvironment as string[] | undefined) ?? [],
  }
}

function parseEnvironment(entries: string[]): Map<string, string> | null {
  const parsed = new Map<string, string>()
  for (const entry of entries) {
    const separator = entry.indexOf('=')
    const name = entry.slice(0, separator)
    if (separator <= 0 || parsed.has(name)) return null
    parsed.set(name, entry.slice(separator + 1))
  }
  return parsed
}

function environmentMatches(actualEntries: string[], imageEntries: string[]): boolean {
  const actual = parseEnvironment(actualEntries)
  const expected = new Map<string, string>()
  for (const entry of imageEntries) {
    const separator = entry.indexOf('=')
    if (separator <= 0) return false
    expected.set(entry.slice(0, separator), entry.slice(separator + 1))
  }
  if (!actual) return false
  for (const name of PROXY_ENV_NAMES) expected.set(name, '')
  return (
    actual.size === expected.size &&
    [...expected].every(([name, value]) => actual.get(name) === value)
  )
}

function empty(value: unknown[] | null | undefined): boolean {
  return value == null || value.length === 0
}

function emptyRecord(value: Record<string, unknown> | null | undefined): boolean {
  return value == null || Object.keys(value).length === 0
}

function sameSet(actual: string[] | null | undefined, expected: string[]): boolean {
  return Boolean(
    actual &&
      actual.length === expected.length &&
      [...actual].sort().join('\0') === [...expected].sort().join('\0'),
  )
}

function assertContainedInspect(params: {
  inspect: ContainedDockerInspect
  containerId: string
  imageId: string
  hostMirrorRoot: string
  guestWorkspacePath: string
  guestCwd: string
  command: string
  imageEnvironment: string[]
  resourceLimits: ContainedExecutionResourceLimits
  user: string
}): void {
  const { inspect: value, resourceLimits: limits } = params
  const mount = value.Mounts[0]
  const healthcheck = value.Config.Healthcheck?.Test
  const valid =
    value.Id === params.containerId &&
    value.Image === params.imageId &&
    value.Config.User === params.user &&
    Array.isArray(value.Config.Entrypoint) &&
    value.Config.Entrypoint.length === 1 &&
    value.Config.Entrypoint[0] === '/bin/sh' &&
    Array.isArray(value.Config.Cmd) &&
    value.Config.Cmd.length === 2 &&
    value.Config.Cmd[0] === '-c' &&
    value.Config.Cmd[1] === params.command &&
    value.Config.WorkingDir === params.guestCwd &&
    Array.isArray(healthcheck) &&
    healthcheck.length === 1 &&
    healthcheck[0] === 'NONE' &&
    environmentMatches(value.Config.Env ?? [], params.imageEnvironment) &&
    value.HostConfig.AutoRemove === false &&
    value.HostConfig.Privileged === false &&
    empty(value.HostConfig.CapAdd) &&
    sameSet(value.HostConfig.CapDrop, ['ALL']) &&
    sameSet(value.HostConfig.SecurityOpt, ['no-new-privileges']) &&
    value.HostConfig.LogConfig != null &&
    exactKeys(value.HostConfig.LogConfig, ['Type', 'Config']) &&
    value.HostConfig.LogConfig.Type === 'none' &&
    value.HostConfig.LogConfig.Config != null &&
    exactKeys(value.HostConfig.LogConfig.Config, []) &&
    empty(value.HostConfig.Devices) &&
    empty(value.HostConfig.DeviceRequests) &&
    empty(value.HostConfig.DeviceCgroupRules) &&
    empty(value.HostConfig.GroupAdd) &&
    empty(value.HostConfig.VolumesFrom) &&
    empty(value.HostConfig.Binds) &&
    emptyRecord(value.HostConfig.PortBindings) &&
    value.HostConfig.PublishAllPorts === false &&
    empty(value.HostConfig.Links) &&
    empty(value.HostConfig.ExtraHosts) &&
    empty(value.HostConfig.Dns) &&
    empty(value.HostConfig.DnsOptions) &&
    empty(value.HostConfig.DnsSearch) &&
    value.HostConfig.NetworkMode === 'none' &&
    value.HostConfig.ReadonlyRootfs === true &&
    value.HostConfig.Tmpfs != null &&
    Object.keys(value.HostConfig.Tmpfs).length === 1 &&
    value.HostConfig.Tmpfs['/tmp'] === TMPFS_OPTIONS &&
    value.HostConfig.Memory === limits.memoryMiB * 1024 * 1024 &&
    value.HostConfig.MemorySwap === limits.memoryMiB * 1024 * 1024 &&
    value.HostConfig.ShmSize === SHM_SIZE_MIB * 1024 * 1024 &&
    value.HostConfig.NanoCpus === Math.round(limits.cpus * 1_000_000_000) &&
    value.HostConfig.PidsLimit === limits.pids &&
    value.HostConfig.RestartPolicy?.Name === 'no' &&
    value.HostConfig.RestartPolicy?.MaximumRetryCount === 0 &&
    value.HostConfig.IpcMode === 'none' &&
    value.HostConfig.PidMode === '' &&
    value.HostConfig.UTSMode === '' &&
    value.HostConfig.UsernsMode === '' &&
    value.HostConfig.CgroupnsMode === 'private' &&
    emptyRecord(value.NetworkSettings.Ports) &&
    value.Mounts.length === 1 &&
    mount?.Type === 'bind' &&
    canonicalPath(mount.Source) === canonicalPath(params.hostMirrorRoot) &&
    mount.Destination === params.guestWorkspacePath &&
    mount.RW === true
  if (!valid) throw new Error('contained_execution_inspect_mismatch')
}

function containerMissing(result: ShellRunResult): boolean {
  return /no such (?:object|container)/i.test(`${result.stdout}\n${result.stderr}`)
}

async function cleanupContainer(
  identity: string,
  executionStarted: boolean,
  dependencies: ContainedDockerDependencies,
  substrate: DockerSubstrateIdentity,
): Promise<void> {
  try {
    await dockerCall(dependencies, substrate, ['rm', '-f', identity], DOCKER_CONTROL_TIMEOUT_MS)
    const inspected = await dockerCall(
      dependencies,
      substrate,
      ['inspect', '--type', 'container', '--format', CONTAINER_INSPECT_FORMAT, identity],
      DOCKER_CONTROL_TIMEOUT_MS,
    )
    if (inspected.timedOut || inspected.exitCode === 0 || !containerMissing(inspected)) {
      throw new ContainedDockerCleanupUnconfirmedError(identity, executionStarted)
    }
  } catch (error) {
    if (error instanceof ContainedDockerCleanupUnconfirmedError) throw error
    throw new ContainedDockerCleanupUnconfirmedError(identity, executionStarted, { cause: error })
  }
}

function limitsFromConfig(config: BelayContainedExecutionConfig): ContainedExecutionResourceLimits {
  return {
    timeoutMs: config.timeoutMs,
    memoryMiB: config.memoryMiB,
    cpus: config.cpus,
    pids: config.pids,
  }
}

function substrateMatches(left: DockerSubstrateIdentity, right: DockerSubstrateIdentity): boolean {
  return (
    left.binaryPath === right.binaryPath &&
    left.binarySha256 === right.binarySha256 &&
    left.endpoint === right.endpoint &&
    left.daemonId === right.daemonId
  )
}

async function substrateFor(params: {
  config: BelayContainedExecutionConfig
  repoRoot: string
  protectedRoots: readonly string[]
  dependencies: ContainedDockerDependencies
}): Promise<DockerSubstrateIdentity> {
  if (!params.config.dockerExecutable || !params.config.dockerHost) {
    throw new ContainedDockerBoundaryUnavailableError('contained_execution_docker_config_missing')
  }
  return params.dependencies.resolveSubstrate({
    executable: params.config.dockerExecutable,
    host: params.config.dockerHost,
    repoRoot: params.repoRoot,
    protectedRoots: params.protectedRoots,
  })
}

export async function probeContainedDockerBoundary(params: {
  repoRoot: string
  protectedRoots: readonly string[]
  imageReference: string
  dockerExecutable: string
  dockerHost: string
  hostProbeRoot: string
  guestWorkspacePath: string
  resourceLimits: ContainedExecutionResourceLimits
  dependencies?: ContainedDockerDependencies
}): Promise<ContainedExecutionAttestation> {
  const dependencies = params.dependencies ?? productionDependencies
  assertResourceLimits(params.resourceLimits)
  const substrate = await dependencies.resolveSubstrate({
    executable: params.dockerExecutable,
    host: params.dockerHost,
    repoRoot: params.repoRoot,
    protectedRoots: params.protectedRoots,
  })
  const image = await resolveLocalImage(params.imageReference, dependencies, substrate)
  const containerName = `belay-contained-${dependencies.randomUUID()}`
  const user = `${dependencies.uid()}:${dependencies.gid()}`
  const args = buildContainedDockerCreateArgs({
    containerName,
    imageId: image.imageId,
    command: ':',
    hostMirrorRoot: params.hostProbeRoot,
    guestWorkspacePath: params.guestWorkspacePath,
    guestCwd: params.guestWorkspacePath,
    resourceLimits: params.resourceLimits,
    user,
  })
  let operationError: unknown
  let identity = containerName
  let executionStarted = false
  try {
    const created = await dockerCall(dependencies, substrate, args, DOCKER_CONTROL_TIMEOUT_MS)
    const captured = created.stdout.trim()
    if (CONTAINER_ID.test(captured)) identity = captured
    if (created.timedOut || created.exitCode !== 0 || !CONTAINER_ID.test(captured)) {
      throw new ContainedDockerBoundaryUnavailableError('contained_execution_probe_create_failed')
    }
    const inspected = await dockerCall(
      dependencies,
      substrate,
      ['inspect', '--type', 'container', '--format', CONTAINER_INSPECT_FORMAT, identity],
      DOCKER_CONTROL_TIMEOUT_MS,
    )
    if (inspected.timedOut || inspected.exitCode !== 0) {
      throw new ContainedDockerBoundaryUnavailableError('contained_execution_probe_inspect_failed')
    }
    assertContainedInspect({
      inspect: parseContainerInspect(inspected, 'contained_execution_probe_inspect'),
      containerId: identity,
      imageId: image.imageId,
      hostMirrorRoot: params.hostProbeRoot,
      guestWorkspacePath: params.guestWorkspacePath,
      guestCwd: params.guestWorkspacePath,
      command: ':',
      imageEnvironment: image.environment,
      resourceLimits: params.resourceLimits,
      user,
    })
    executionStarted = true
    let started: ShellRunResult
    try {
      started = await dockerCall(
        dependencies,
        substrate,
        ['start', '--attach', identity],
        params.resourceLimits.timeoutMs,
      )
    } catch (error) {
      throw new ContainedDockerStartAttemptError({ cause: error })
    }
    if (started.timedOut || started.exitCode !== 0) {
      throw new ContainedDockerStartAttemptError()
    }
  } catch (error) {
    operationError = error
  }
  await cleanupContainer(identity, executionStarted, dependencies, substrate)
  if (operationError) throw operationError
  const probedAtMs = dependencies.now()
  return {
    version: 1,
    imageId: image.imageId,
    imageReference: params.imageReference,
    networkNone: true,
    isolatesWorkspaceMirror: true,
    readOnlyRoot: true,
    sanitizedEnvironment: true,
    dockerSubstrate: substrate,
    dockerConfiguration: {
      executable: params.dockerExecutable,
      host: params.dockerHost,
    },
    user,
    entrypoint: '/bin/sh',
    capDropAll: true,
    noNewPrivileges: true,
    logDriver: 'none',
    proxyEnvironment: 'neutralized-empty',
    tmpfs: {
      path: '/tmp',
      sizeBytes: TMPFS_SIZE_BYTES,
      mode: 0o1777,
      exec: false,
      nosuid: true,
      nodev: true,
    },
    memorySwapMiB: params.resourceLimits.memoryMiB,
    shmSizeMiB: SHM_SIZE_MIB,
    healthcheckDisabled: true,
    privateNamespaces: true,
    privileged: false,
    devicesNone: true,
    resourceLimits: { ...params.resourceLimits },
    probedAt: new Date(probedAtMs).toISOString(),
    expiresAt: new Date(probedAtMs + CONTAINED_ATTESTATION_TTL_MS).toISOString(),
  }
}

async function validatedGuestCwd(params: {
  mirror: ContainedExecutionMirrorHandle
  repoRoot: string
  protectedRoots: readonly string[]
  controlPlaneDir: string
  guestCwd: string
}): Promise<string> {
  const requiredExclusions = [
    ...new Set([params.controlPlaneDir, ...params.protectedRoots].map(canonicalPath)),
  ]
  if (
    params.mirror.backend !== 'file_copy' ||
    params.mirror.guestWorkspacePath !== path.resolve(params.repoRoot) ||
    !path.isAbsolute(params.guestCwd) ||
    !pathWithinRoot(params.mirror.guestWorkspacePath, params.guestCwd)
  )
    throw new Error('contained_execution_invalid_cwd')
  const resolvedRoot = await realpath(params.mirror.hostMirrorRoot)
  const protectedRoots = [canonicalPath(params.repoRoot), ...requiredExclusions]
  if (protectedRoots.some((root) => overlaps(resolvedRoot, root))) {
    throw new Error('contained_execution_protected_root_overlap')
  }
  if (
    !validateContainedExecutionMirrorLease(params.mirror, {
      sourceRoot: params.repoRoot,
      protectedRoots: requiredExclusions,
    })
  )
    throw new Error('contained_execution_invalid_mirror_lease')
  const relative = path.relative(params.mirror.guestWorkspacePath, path.resolve(params.guestCwd))
  let resolvedCwd: string
  try {
    resolvedCwd = await realpath(path.join(resolvedRoot, relative))
  } catch {
    throw new Error('contained_execution_invalid_cwd')
  }
  const info = await lstat(resolvedCwd)
  if (!info.isDirectory() || !pathWithinRoot(resolvedRoot, resolvedCwd)) {
    throw new Error('contained_execution_invalid_cwd')
  }
  return path.join(params.mirror.guestWorkspacePath, path.relative(resolvedRoot, resolvedCwd))
}

export interface ContainedExecutionReceipt {
  version: 1
  actionFingerprint: string
  attestationDigest: string
  executionStarted: true
  timeoutMs: number
  dockerSubstrate: DockerSubstrateIdentity
  imageId: string
  mirror: {
    backend: ContainedExecutionMirrorBackend
    type: 'bind'
    cardinality: 1
    readWrite: true
    sourceFingerprint: string
    guestWorkspacePathFingerprint: string
    guestCwdFingerprint: string
  }
  logging: { driver: 'none'; config: Record<string, never> }
  network: {
    mode: 'none'
    publishAllPorts: false
    portBindings: Record<string, never>
    links: []
    extraHosts: []
    dns: []
    dnsOptions: []
    dnsSearch: []
  }
  readOnlyRoot: true
  tmpfs: { path: '/tmp'; sizeBytes: number; mode: 0o1777; exec: false; nosuid: true; nodev: true }
  environment: {
    hostForwarded: false
    proxyEnvironment: 'neutralized-empty'
    neutralizedVariables: readonly string[]
    imageEnvironmentDigest: string
  }
  privilege: {
    privileged: false
    noNewPrivileges: true
    capAdd: []
    capDrop: ['ALL']
    groupAdd: []
  }
  devices: { devices: []; deviceRequests: []; deviceCgroupRules: [] }
  storage: { volumesFrom: []; bindsOutsideMirror: [] }
  namespaces: { ipc: 'none'; pid: 'private'; uts: 'private'; cgroup: 'private'; user: 'default' }
  healthcheckDisabled: true
  lifecycle: { autoRemove: false; restart: 'no'; maximumRetryCount: 0 }
  resources: {
    memoryMiB: number
    memorySwapMiB: number
    shmSizeMiB: number
    cpus: number
    nanoCpus: number
    pids: number
  }
  user: string
  entrypoint: '/bin/sh'
  exitCode: number | null
  timedOut: boolean
}

export interface ContainedDockerExecutionResult extends ShellRunResult {
  executionStarted: true
  receipt: ContainedExecutionReceipt
  receiptHash: string
}

export interface ExecuteContainedDockerParams {
  repoRoot: string
  controlPlaneDir: string
  protectedRoots: readonly string[]
  config: BelayContainedExecutionConfig
  mirror: ContainedExecutionMirrorHandle
  guestCwd: string
  command: string
  signedAttestation: unknown
  dependencies?: ContainedDockerDependencies
}

function exactKeys(value: object, allowed: readonly string[]): boolean {
  const names = new Set(allowed)
  return Object.keys(value).every((name) => names.has(name))
}

function limitsEqual(
  left: ContainedExecutionResourceLimits,
  right: ContainedExecutionResourceLimits,
): boolean {
  return (
    left.timeoutMs === right.timeoutMs &&
    left.memoryMiB === right.memoryMiB &&
    left.cpus === right.cpus &&
    left.pids === right.pids
  )
}

export async function executeContainedDocker(
  params: ExecuteContainedDockerParams,
): Promise<ContainedDockerExecutionResult> {
  if (
    !exactKeys(params, [
      'repoRoot',
      'controlPlaneDir',
      'protectedRoots',
      'config',
      'mirror',
      'guestCwd',
      'command',
      'signedAttestation',
      'dependencies',
    ]) ||
    !exactKeys(params.config, [
      'enabled',
      'image',
      'dockerExecutable',
      'dockerHost',
      'timeoutMs',
      'memoryMiB',
      'cpus',
      'pids',
    ]) ||
    !exactKeys(params.mirror, ['hostMirrorRoot', 'guestWorkspacePath', 'backend', 'cleanup'])
  ) {
    throw new Error('contained_execution_unknown_option')
  }
  if (!params.config.enabled || !params.config.image)
    throw new Error('contained_execution_disabled')
  const dependencies = params.dependencies ?? productionDependencies
  const limits = limitsFromConfig(params.config)
  assertResourceLimits(limits)
  const guestCwd = await validatedGuestCwd(params)
  const verified = await verifySignedBoundaryAttestation({
    file: params.signedAttestation,
    expectedRepoRoot: params.repoRoot,
    controlPlaneDir: params.controlPlaneDir,
  })
  const current = dependencies.now()
  const capability = verified?.driver === 'container' ? verified.containedExecution : undefined
  if (
    !capability ||
    !isContainedExecutionAttestationFresh(capability, current) ||
    !verified ||
    Date.parse(verified.probedAt) > current ||
    Date.parse(verified.expiresAt) <= current
  )
    throw new Error('contained_execution_capability_invalid')
  if (
    !limitsEqual(capability.resourceLimits, limits) ||
    capability.memorySwapMiB !== limits.memoryMiB ||
    capability.shmSizeMiB !== SHM_SIZE_MIB ||
    capability.healthcheckDisabled !== true ||
    capability.privateNamespaces !== true ||
    capability.privileged !== false ||
    capability.devicesNone !== true ||
    capability.tmpfs.sizeBytes !== TMPFS_SIZE_BYTES ||
    capability.tmpfs.exec !== false ||
    capability.proxyEnvironment !== 'neutralized-empty' ||
    capability.entrypoint !== '/bin/sh' ||
    capability.capDropAll !== true ||
    capability.noNewPrivileges !== true ||
    capability.logDriver !== 'none' ||
    capability.imageReference !== params.config.image ||
    capability.dockerConfiguration.executable !== params.config.dockerExecutable ||
    capability.dockerConfiguration.host !== params.config.dockerHost
  )
    throw new Error('contained_execution_capability_mismatch')
  const substrate = await substrateFor({
    config: params.config,
    repoRoot: params.repoRoot,
    protectedRoots: params.protectedRoots,
    dependencies,
  })
  if (!substrateMatches(substrate, capability.dockerSubstrate)) {
    throw new ContainedDockerBoundaryUnavailableError(
      'contained_execution_docker_substrate_mismatch',
    )
  }
  const image = await resolveLocalImage(params.config.image, dependencies, substrate)
  if (image.imageId !== capability.imageId) throw new Error('contained_execution_image_mismatch')
  const user = `${dependencies.uid()}:${dependencies.gid()}`
  if (user !== capability.user) throw new Error('contained_execution_capability_mismatch')
  const containerName = `belay-contained-${dependencies.randomUUID()}`
  const createArgs = buildContainedDockerCreateArgs({
    containerName,
    imageId: image.imageId,
    command: params.command,
    hostMirrorRoot: params.mirror.hostMirrorRoot,
    guestWorkspacePath: params.mirror.guestWorkspacePath,
    guestCwd,
    resourceLimits: limits,
    user,
  })

  let identity = containerName
  let executionStarted = false
  let operationError: unknown
  let startResult: ShellRunResult | undefined
  try {
    const created = await dockerCall(dependencies, substrate, createArgs, DOCKER_CONTROL_TIMEOUT_MS)
    const captured = created.stdout.trim()
    if (CONTAINER_ID.test(captured)) identity = captured
    if (created.timedOut || created.exitCode !== 0 || !CONTAINER_ID.test(captured)) {
      throw new ContainedDockerBoundaryUnavailableError('contained_execution_create_failed')
    }
    const inspected = await dockerCall(
      dependencies,
      substrate,
      ['inspect', '--type', 'container', '--format', CONTAINER_INSPECT_FORMAT, identity],
      DOCKER_CONTROL_TIMEOUT_MS,
    )
    if (inspected.timedOut || inspected.exitCode !== 0) {
      throw new ContainedDockerBoundaryUnavailableError('contained_execution_inspect_failed')
    }
    try {
      assertContainedInspect({
        inspect: parseContainerInspect(inspected, 'contained_execution_inspect'),
        containerId: identity,
        imageId: image.imageId,
        hostMirrorRoot: params.mirror.hostMirrorRoot,
        guestWorkspacePath: params.mirror.guestWorkspacePath,
        guestCwd,
        command: params.command,
        imageEnvironment: image.environment,
        resourceLimits: limits,
        user,
      })
    } catch (error) {
      if (error instanceof ContainedDockerBoundaryUnavailableError) throw error
      throw new ContainedDockerBoundaryUnavailableError('contained_execution_inspect_mismatch', {
        cause: error,
      })
    }
    executionStarted = true
    try {
      startResult = await dockerCall(
        dependencies,
        substrate,
        ['start', '--attach', identity],
        limits.timeoutMs,
      )
    } catch (error) {
      throw new ContainedDockerStartAttemptError({ cause: error })
    }
  } catch (error) {
    operationError = error
  }
  await cleanupContainer(identity, executionStarted, dependencies, substrate)
  if (operationError) throw operationError
  if (!startResult) throw new ContainedDockerStartAttemptError()

  const receipt: ContainedExecutionReceipt = {
    version: 1,
    actionFingerprint: hashValue(
      canonicalStringify({ version: 1, command: params.command, guestCwd }),
    ),
    attestationDigest: hashValue(canonicalStringify(params.signedAttestation)),
    executionStarted: true,
    timeoutMs: limits.timeoutMs,
    dockerSubstrate: substrate,
    imageId: image.imageId,
    mirror: {
      backend: params.mirror.backend,
      type: 'bind',
      cardinality: 1,
      readWrite: true,
      sourceFingerprint: hashValue(canonicalPath(params.mirror.hostMirrorRoot)),
      guestWorkspacePathFingerprint: hashValue(canonicalPath(params.mirror.guestWorkspacePath)),
      guestCwdFingerprint: hashValue(canonicalPath(guestCwd)),
    },
    logging: { driver: 'none', config: {} },
    network: {
      mode: 'none',
      publishAllPorts: false,
      portBindings: {},
      links: [],
      extraHosts: [],
      dns: [],
      dnsOptions: [],
      dnsSearch: [],
    },
    readOnlyRoot: true,
    tmpfs: {
      path: '/tmp',
      sizeBytes: TMPFS_SIZE_BYTES,
      mode: 0o1777,
      exec: false,
      nosuid: true,
      nodev: true,
    },
    environment: {
      hostForwarded: false,
      proxyEnvironment: 'neutralized-empty',
      neutralizedVariables: [...PROXY_ENV_NAMES],
      imageEnvironmentDigest: hashValue(canonicalStringify(image.environment)),
    },
    privilege: {
      privileged: false,
      noNewPrivileges: true,
      capAdd: [],
      capDrop: ['ALL'],
      groupAdd: [],
    },
    devices: { devices: [], deviceRequests: [], deviceCgroupRules: [] },
    storage: { volumesFrom: [], bindsOutsideMirror: [] },
    namespaces: { ipc: 'none', pid: 'private', uts: 'private', cgroup: 'private', user: 'default' },
    healthcheckDisabled: true,
    lifecycle: { autoRemove: false, restart: 'no', maximumRetryCount: 0 },
    resources: {
      memoryMiB: limits.memoryMiB,
      memorySwapMiB: limits.memoryMiB,
      shmSizeMiB: SHM_SIZE_MIB,
      cpus: limits.cpus,
      nanoCpus: Math.round(limits.cpus * 1_000_000_000),
      pids: limits.pids,
    },
    user,
    entrypoint: '/bin/sh',
    exitCode: startResult.exitCode,
    timedOut: startResult.timedOut,
  }
  return {
    ...startResult,
    executionStarted: true,
    receipt,
    receiptHash: hashValue(canonicalStringify(receipt)),
  }
}

export async function probeContainedDockerForSession(params: {
  repoRoot: string
  controlPlaneDir: string
  config: BelayContainedExecutionConfig
  dependencies?: ContainedDockerDependencies
}): Promise<BoundaryAttestation> {
  if (
    !params.config.enabled ||
    !params.config.image ||
    !params.config.dockerExecutable ||
    !params.config.dockerHost
  )
    throw new Error('contained_execution_disabled')
  const probeRoot = await mkdtemp(path.join(os.tmpdir(), 'belay-contained-probe-'))
  let probeError: unknown
  let capability: ContainedExecutionAttestation | undefined
  try {
    capability = await probeContainedDockerBoundary({
      repoRoot: params.repoRoot,
      protectedRoots: [params.controlPlaneDir],
      imageReference: params.config.image,
      dockerExecutable: params.config.dockerExecutable,
      dockerHost: params.config.dockerHost,
      hostProbeRoot: probeRoot,
      guestWorkspacePath: path.resolve(params.repoRoot),
      resourceLimits: limitsFromConfig(params.config),
      dependencies: params.dependencies,
    })
  } catch (error) {
    probeError = error
  }
  try {
    await rm(probeRoot, { recursive: true, force: true })
    await lstat(probeRoot)
    throw new Error('contained_execution_probe_root_cleanup_unconfirmed')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  if (probeError) throw probeError
  if (!capability) throw new Error('contained_execution_probe_failed')
  return {
    version: 1,
    driver: 'container',
    probedAt: capability.probedAt,
    expiresAt: capability.expiresAt,
    deniesUngrantedEffects: false,
    materializesGrants: false,
    isolatesWorkspaceMounts: false,
    probeSignals: ['docker', 'contained-execution', 'network-none', 'immutable-image'],
    containedExecution: capability,
  }
}
