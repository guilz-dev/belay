import { randomUUID } from 'node:crypto'
import { lstat, mkdtemp, realpath, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import type {
  BoundaryAttestation,
  ContainedExecutionAttestation,
  ContainedExecutionResourceLimits,
} from '../capability/attestation.js'
import { isContainedExecutionAttestationFresh } from '../capability/attestation.js'
import { verifySignedBoundaryAttestation } from '../capability/boundary-attestation-sign.js'
import type { BelayContainedExecutionConfig } from '../config.js'
import { canonicalStringify, hashValue } from '../fingerprint.js'
import { canonicalPath, pathWithinRoot } from '../path-utils.js'
import { runProcessWithBoundedOutput, type ShellRunResult } from '../process-runner.js'
import type { ContainedExecutionMirrorBackend, ContainedExecutionMirrorHandle } from './mirror.js'

const DOCKER_CONTROL_TIMEOUT_MS = 10_000
const CONTAINED_ATTESTATION_TTL_MS = 15 * 60_000
const TMPFS_SIZE_BYTES = 64 * 1024 * 1024
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
const IMAGE_ID = /^sha256:[a-f0-9]{64}$/
const SAFE_CONTAINER_NAME = /^belay-contained-[0-9a-f-]{36}$/

export const CONTAINED_EXECUTION_CONTAINER_CLEANUP_UNCONFIRMED =
  'contained_execution_container_cleanup_unconfirmed'

export class ContainedDockerCleanupUnconfirmedError extends Error {
  readonly code = CONTAINED_EXECUTION_CONTAINER_CLEANUP_UNCONFIRMED
  readonly executionStarted = true
  readonly cleanupConfirmed = false

  constructor(readonly containerName: string) {
    super(`${CONTAINED_EXECUTION_CONTAINER_CLEANUP_UNCONFIRMED}: ${containerName}`)
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
  }
  HostConfig: {
    NetworkMode: string
    ReadonlyRootfs: boolean
    Tmpfs: Record<string, string> | null
    CapDrop: string[] | null
    SecurityOpt: string[] | null
    Memory: number
    NanoCpus: number
    PidsLimit: number | null
    Devices?: unknown[] | null
    Binds?: string[] | null
    ExtraHosts?: string[] | null
  }
  Mounts: Array<{
    Type: string
    Source: string
    Destination: string
    RW: boolean
  }>
}

export interface ContainedDockerDependencies {
  runDocker(args: string[], timeoutMs: number): Promise<ShellRunResult>
  now(): number
  randomUUID(): string
  uid(): number
  gid(): number
}

const productionDependencies: ContainedDockerDependencies = {
  runDocker: (args, timeoutMs) => runProcessWithBoundedOutput('docker', args, {}, timeoutMs),
  now: () => Date.now(),
  randomUUID,
  uid: () => {
    if (!process.getuid) {
      throw new Error('contained_execution_host_identity_unavailable')
    }
    return process.getuid()
  },
  gid: () => {
    if (!process.getgid) {
      throw new Error('contained_execution_host_identity_unavailable')
    }
    return process.getgid()
  },
}

function exactKeys(value: object, allowed: readonly string[]): boolean {
  const allowedSet = new Set(allowed)
  return Object.keys(value).every((key) => allowedSet.has(key))
}

function assertSafeDockerPath(value: string, errorCode: string): void {
  if (
    !path.isAbsolute(value) ||
    value.includes('\0') ||
    value.includes('\n') ||
    value.includes('\r') ||
    value.includes(',')
  ) {
    throw new Error(errorCode)
  }
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
  ) {
    throw new Error('contained_execution_resource_limits_invalid')
  }
}

export interface BuildContainedDockerArgsParams {
  operation: 'create' | 'run'
  containerName: string
  imageId: string
  command: string
  hostMirrorRoot: string
  guestWorkspacePath: string
  guestCwd: string
  resourceLimits: ContainedExecutionResourceLimits
  user: string
}

export function buildContainedDockerArgs(params: BuildContainedDockerArgsParams): string[] {
  if (!IMAGE_ID.test(params.imageId)) {
    throw new Error('contained_execution_invalid_image_id')
  }
  if (!SAFE_CONTAINER_NAME.test(params.containerName)) {
    throw new Error('contained_execution_invalid_container_name')
  }
  assertSafeDockerPath(params.hostMirrorRoot, 'contained_execution_invalid_mount')
  assertSafeDockerPath(params.guestWorkspacePath, 'contained_execution_invalid_mount')
  assertSafeDockerPath(params.guestCwd, 'contained_execution_invalid_cwd')
  assertResourceLimits(params.resourceLimits)
  if (!/^\d+:\d+$/.test(params.user)) {
    throw new Error('contained_execution_invalid_user')
  }

  return [
    params.operation,
    ...(params.operation === 'run' ? ['--rm'] : []),
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
    '--memory',
    `${params.resourceLimits.memoryMiB}m`,
    '--cpus',
    String(params.resourceLimits.cpus),
    '--pids-limit',
    String(params.resourceLimits.pids),
    '--user',
    params.user,
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

function parseSingleInspect<T>(output: string, errorCode: string): T {
  let parsed: unknown
  try {
    parsed = JSON.parse(output)
  } catch {
    throw new Error(errorCode)
  }
  if (
    !Array.isArray(parsed) ||
    parsed.length !== 1 ||
    !parsed[0] ||
    typeof parsed[0] !== 'object'
  ) {
    throw new Error(errorCode)
  }
  return parsed[0] as T
}

interface LocalDockerImage {
  imageId: string
  environment: string[]
}

async function resolveLocalImage(
  imageReference: string,
  dependencies: ContainedDockerDependencies,
): Promise<LocalDockerImage> {
  if (!imageReference.trim() || /[\0\n\r]/.test(imageReference)) {
    throw new Error('contained_execution_image_missing')
  }
  const inspected = await dependencies.runDocker(
    ['image', 'inspect', imageReference],
    DOCKER_CONTROL_TIMEOUT_MS,
  )
  if (inspected.timedOut || inspected.exitCode !== 0) {
    throw new Error('contained_execution_image_missing')
  }
  const image = parseSingleInspect<{
    Id?: unknown
    Config?: { Env?: unknown }
  }>(inspected.stdout, 'contained_execution_image_inspect_invalid')
  if (
    typeof image.Id !== 'string' ||
    !IMAGE_ID.test(image.Id) ||
    (image.Config?.Env != null &&
      (!Array.isArray(image.Config.Env) ||
        !image.Config.Env.every((entry) => typeof entry === 'string')))
  ) {
    throw new Error('contained_execution_image_inspect_invalid')
  }
  return {
    imageId: image.Id,
    environment: (image.Config?.Env as string[] | null | undefined) ?? [],
  }
}

function envLastValue(env: string[], name: string): string | undefined {
  let value: string | undefined
  for (const entry of env) {
    const separator = entry.indexOf('=')
    if (separator >= 0 && entry.slice(0, separator) === name) {
      value = entry.slice(separator + 1)
    }
  }
  return value
}

function parseEnvironment(env: string[]): Map<string, string> | null {
  const parsed = new Map<string, string>()
  for (const entry of env) {
    const separator = entry.indexOf('=')
    const name = entry.slice(0, separator)
    if (separator <= 0 || parsed.has(name)) {
      return null
    }
    parsed.set(name, entry.slice(separator + 1))
  }
  return parsed
}

function environmentMatchesImageWithNeutralizedProxy(
  actualEntries: string[],
  imageEntries: string[],
): boolean {
  const actual = parseEnvironment(actualEntries)
  const expected = parseEnvironment(imageEntries)
  if (!actual || !expected) {
    return false
  }
  for (const name of PROXY_ENV_NAMES) {
    expected.set(name, '')
  }
  return (
    actual.size === expected.size &&
    [...expected].every(([name, value]) => actual.get(name) === value)
  )
}

function sameStringSet(actual: string[] | null | undefined, expected: string[]): boolean {
  return (
    Array.isArray(actual) &&
    actual.length === expected.length &&
    [...actual].sort().join('\0') === [...expected].sort().join('\0')
  )
}

function arrayEmpty(value: unknown[] | null | undefined): boolean {
  return value == null || value.length === 0
}

function assertContainedInspect(params: {
  inspect: ContainedDockerInspect
  imageId: string
  hostMirrorRoot: string
  guestWorkspacePath: string
  guestCwd: string
  command: string
  imageEnvironment: string[]
  resourceLimits: ContainedExecutionResourceLimits
  user: string
}): void {
  const { inspect, resourceLimits } = params
  const env = inspect.Config.Env ?? []
  const mount = inspect.Mounts[0]
  const valid =
    inspect.Image === params.imageId &&
    inspect.HostConfig.NetworkMode === 'none' &&
    inspect.HostConfig.ReadonlyRootfs === true &&
    inspect.HostConfig.Tmpfs != null &&
    Object.keys(inspect.HostConfig.Tmpfs).length === 1 &&
    inspect.HostConfig.Tmpfs['/tmp'] === TMPFS_OPTIONS &&
    sameStringSet(inspect.HostConfig.CapDrop, ['ALL']) &&
    sameStringSet(inspect.HostConfig.SecurityOpt, ['no-new-privileges']) &&
    inspect.HostConfig.Memory === resourceLimits.memoryMiB * 1024 * 1024 &&
    inspect.HostConfig.NanoCpus === Math.round(resourceLimits.cpus * 1_000_000_000) &&
    inspect.HostConfig.PidsLimit === resourceLimits.pids &&
    arrayEmpty(inspect.HostConfig.Devices) &&
    arrayEmpty(inspect.HostConfig.Binds) &&
    arrayEmpty(inspect.HostConfig.ExtraHosts) &&
    inspect.Config.User === params.user &&
    Array.isArray(inspect.Config.Entrypoint) &&
    inspect.Config.Entrypoint.length === 1 &&
    inspect.Config.Entrypoint[0] === '/bin/sh' &&
    Array.isArray(inspect.Config.Cmd) &&
    inspect.Config.Cmd.length === 2 &&
    inspect.Config.Cmd[0] === '-c' &&
    inspect.Config.Cmd[1] === params.command &&
    inspect.Config.WorkingDir === params.guestCwd &&
    inspect.Mounts.length === 1 &&
    mount?.Type === 'bind' &&
    canonicalPath(mount.Source) === canonicalPath(params.hostMirrorRoot) &&
    mount.Destination === params.guestWorkspacePath &&
    mount.RW === true &&
    PROXY_ENV_NAMES.every((name) => envLastValue(env, name) === '') &&
    environmentMatchesImageWithNeutralizedProxy(env, params.imageEnvironment)

  if (!valid) {
    throw new Error('contained_execution_probe_mismatch')
  }
}

function containerMissing(result: ShellRunResult): boolean {
  return /no such (?:object|container)/i.test(`${result.stdout}\n${result.stderr}`)
}

async function cleanupContainer(
  containerName: string,
  dependencies: ContainedDockerDependencies,
): Promise<void> {
  await dependencies.runDocker(['rm', '-f', containerName], DOCKER_CONTROL_TIMEOUT_MS)
  const inspected = await dependencies.runDocker(
    ['inspect', '--type', 'container', containerName],
    DOCKER_CONTROL_TIMEOUT_MS,
  )
  if (inspected.timedOut || inspected.exitCode === 0 || !containerMissing(inspected)) {
    throw new ContainedDockerCleanupUnconfirmedError(containerName)
  }
}

function resourceLimitsFromConfig(
  config: BelayContainedExecutionConfig,
): ContainedExecutionResourceLimits {
  return {
    timeoutMs: config.timeoutMs,
    memoryMiB: config.memoryMiB,
    cpus: config.cpus,
    pids: config.pids,
  }
}

export async function probeContainedDockerBoundary(params: {
  imageReference: string
  hostProbeRoot: string
  guestWorkspacePath: string
  resourceLimits: ContainedExecutionResourceLimits
  dependencies?: ContainedDockerDependencies
}): Promise<ContainedExecutionAttestation> {
  const dependencies = params.dependencies ?? productionDependencies
  const resourceLimits: ContainedExecutionResourceLimits = {
    timeoutMs: params.resourceLimits.timeoutMs,
    memoryMiB: params.resourceLimits.memoryMiB,
    cpus: params.resourceLimits.cpus,
    pids: params.resourceLimits.pids,
  }
  assertResourceLimits(resourceLimits)
  const image = await resolveLocalImage(params.imageReference, dependencies)
  const { imageId } = image
  const containerName = `belay-contained-${dependencies.randomUUID()}`
  const user = `${dependencies.uid()}:${dependencies.gid()}`
  const args = buildContainedDockerArgs({
    operation: 'create',
    containerName,
    imageId,
    command: ':',
    hostMirrorRoot: params.hostProbeRoot,
    guestWorkspacePath: params.guestWorkspacePath,
    guestCwd: params.guestWorkspacePath,
    resourceLimits,
    user,
  })

  let operationError: unknown
  try {
    const created = await dependencies.runDocker(args, DOCKER_CONTROL_TIMEOUT_MS)
    if (created.timedOut || created.exitCode !== 0) {
      throw new Error('contained_execution_probe_create_failed')
    }
    const inspected = await dependencies.runDocker(
      ['inspect', '--type', 'container', containerName],
      DOCKER_CONTROL_TIMEOUT_MS,
    )
    if (inspected.timedOut || inspected.exitCode !== 0) {
      throw new Error('contained_execution_probe_inspect_failed')
    }
    assertContainedInspect({
      inspect: parseSingleInspect<ContainedDockerInspect>(
        inspected.stdout,
        'contained_execution_probe_inspect_invalid',
      ),
      imageId,
      hostMirrorRoot: params.hostProbeRoot,
      guestWorkspacePath: params.guestWorkspacePath,
      guestCwd: params.guestWorkspacePath,
      command: ':',
      imageEnvironment: image.environment,
      resourceLimits,
      user,
    })
    const started = await dependencies.runDocker(
      ['start', '--attach', containerName],
      resourceLimits.timeoutMs,
    )
    if (started.timedOut || started.exitCode !== 0) {
      throw new Error('contained_execution_probe_run_failed')
    }
  } catch (error) {
    operationError = error
  }

  await cleanupContainer(containerName, dependencies)
  if (operationError) {
    throw operationError
  }

  const probedAtMs = dependencies.now()
  const probedAt = new Date(probedAtMs).toISOString()
  return {
    version: 1,
    imageId,
    networkNone: true,
    isolatesWorkspaceMirror: true,
    readOnlyRoot: true,
    sanitizedEnvironment: true,
    user,
    entrypoint: '/bin/sh',
    capDropAll: true,
    noNewPrivileges: true,
    proxyEnvironment: 'neutralized-empty',
    tmpfs: {
      path: '/tmp',
      sizeBytes: TMPFS_SIZE_BYTES,
      mode: 0o1777,
      exec: false,
      nosuid: true,
      nodev: true,
    },
    resourceLimits,
    probedAt,
    expiresAt: new Date(probedAtMs + CONTAINED_ATTESTATION_TTL_MS).toISOString(),
  }
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

async function validatedGuestCwd(
  mirror: ContainedExecutionMirrorHandle,
  repoRoot: string,
  guestCwd: string,
): Promise<string> {
  if (
    mirror.backend !== 'file_copy' ||
    mirror.guestWorkspacePath !== path.resolve(repoRoot) ||
    !path.isAbsolute(guestCwd) ||
    !pathWithinRoot(mirror.guestWorkspacePath, guestCwd)
  ) {
    throw new Error('contained_execution_invalid_cwd')
  }
  assertSafeDockerPath(mirror.hostMirrorRoot, 'contained_execution_invalid_mount')
  assertSafeDockerPath(mirror.guestWorkspacePath, 'contained_execution_invalid_mount')
  assertSafeDockerPath(guestCwd, 'contained_execution_invalid_cwd')

  const rootInfo = await lstat(mirror.hostMirrorRoot)
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) {
    throw new Error('contained_execution_invalid_mount')
  }
  const relative = path.relative(mirror.guestWorkspacePath, path.resolve(guestCwd))
  const hostCwd = path.join(mirror.hostMirrorRoot, relative)
  let resolvedRoot: string
  let resolvedCwd: string
  try {
    ;[resolvedRoot, resolvedCwd] = await Promise.all([
      realpath(mirror.hostMirrorRoot),
      realpath(hostCwd),
    ])
  } catch {
    throw new Error('contained_execution_invalid_cwd')
  }
  const canonicalRepoRoot = canonicalPath(repoRoot)
  if (
    pathWithinRoot(canonicalRepoRoot, resolvedRoot) ||
    pathWithinRoot(resolvedRoot, canonicalRepoRoot)
  ) {
    throw new Error('contained_execution_invalid_mount')
  }
  const cwdInfo = await lstat(resolvedCwd)
  if (!cwdInfo.isDirectory() || !pathWithinRoot(resolvedRoot, resolvedCwd)) {
    throw new Error('contained_execution_invalid_cwd')
  }
  const canonicalRelative = path.relative(resolvedRoot, resolvedCwd)
  return path.join(mirror.guestWorkspacePath, canonicalRelative)
}

export interface ContainedExecutionReceipt {
  version: 1
  imageId: string
  mirrorBackend: ContainedExecutionMirrorBackend
  networkMode: 'none'
  readOnlyRoot: true
  tmpfsPath: '/tmp'
  tmpfsSizeBytes: number
  tmpfsExec: false
  capDrop: 'ALL'
  noNewPrivileges: true
  memoryBytes: number
  nanoCpus: number
  pidsLimit: number
  user: string
  entrypoint: '/bin/sh'
  proxyEnvironment: 'neutralized-empty'
  guestWorkspacePath: string
  guestCwd: string
  exitCode: number | null
  timedOut: boolean
}

export interface ContainedDockerExecutionResult extends ShellRunResult {
  receipt: ContainedExecutionReceipt
  receiptHash: string
}

export interface ExecuteContainedDockerParams {
  repoRoot: string
  controlPlaneDir: string
  config: BelayContainedExecutionConfig
  mirror: ContainedExecutionMirrorHandle
  guestCwd: string
  command: string
  signedAttestation: unknown
  dependencies?: ContainedDockerDependencies
}

export async function executeContainedDocker(
  params: ExecuteContainedDockerParams,
): Promise<ContainedDockerExecutionResult> {
  if (
    !exactKeys(params, [
      'repoRoot',
      'controlPlaneDir',
      'config',
      'mirror',
      'guestCwd',
      'command',
      'signedAttestation',
      'dependencies',
    ]) ||
    !exactKeys(params.config, ['enabled', 'image', 'timeoutMs', 'memoryMiB', 'cpus', 'pids']) ||
    !exactKeys(params.mirror, ['hostMirrorRoot', 'guestWorkspacePath', 'backend', 'cleanup'])
  ) {
    throw new Error('contained_execution_unknown_option')
  }
  if (!params.config.enabled || !params.config.image) {
    throw new Error('contained_execution_disabled')
  }
  const resourceLimits = resourceLimitsFromConfig(params.config)
  assertResourceLimits(resourceLimits)
  const guestCwd = await validatedGuestCwd(params.mirror, params.repoRoot, params.guestCwd)
  const verified = await verifySignedBoundaryAttestation({
    file: params.signedAttestation,
    expectedRepoRoot: params.repoRoot,
    controlPlaneDir: params.controlPlaneDir,
  })
  const dependencies = params.dependencies ?? productionDependencies
  const capability = verified?.driver === 'container' ? verified.containedExecution : undefined
  const currentTime = dependencies.now()
  const envelopeProbedAt = verified ? Date.parse(verified.probedAt) : Number.NaN
  const envelopeExpiresAt = verified ? Date.parse(verified.expiresAt) : Number.NaN
  if (
    !capability ||
    !Number.isFinite(envelopeProbedAt) ||
    !Number.isFinite(envelopeExpiresAt) ||
    envelopeProbedAt > currentTime ||
    envelopeExpiresAt <= currentTime ||
    !isContainedExecutionAttestationFresh(capability, currentTime)
  ) {
    throw new Error('contained_execution_capability_invalid')
  }
  if (!limitsEqual(capability.resourceLimits, resourceLimits)) {
    throw new Error('contained_execution_capability_mismatch')
  }
  if (
    capability.tmpfs.sizeBytes !== TMPFS_SIZE_BYTES ||
    capability.tmpfs.exec !== false ||
    capability.proxyEnvironment !== 'neutralized-empty' ||
    capability.entrypoint !== '/bin/sh' ||
    capability.capDropAll !== true ||
    capability.noNewPrivileges !== true
  ) {
    throw new Error('contained_execution_capability_mismatch')
  }

  const imageId = (await resolveLocalImage(params.config.image, dependencies)).imageId
  if (imageId !== capability.imageId) {
    throw new Error('contained_execution_image_mismatch')
  }
  const containerName = `belay-contained-${dependencies.randomUUID()}`
  const user = `${dependencies.uid()}:${dependencies.gid()}`
  if (user !== capability.user) {
    throw new Error('contained_execution_capability_mismatch')
  }
  const args = buildContainedDockerArgs({
    operation: 'run',
    containerName,
    imageId,
    command: params.command,
    hostMirrorRoot: params.mirror.hostMirrorRoot,
    guestWorkspacePath: params.mirror.guestWorkspacePath,
    guestCwd,
    resourceLimits,
    user,
  })

  let run: ShellRunResult | undefined
  let operationError: unknown
  try {
    run = await dependencies.runDocker(args, resourceLimits.timeoutMs)
  } catch (error) {
    operationError = error
  }
  await cleanupContainer(containerName, dependencies)
  if (operationError) {
    throw operationError
  }
  if (!run) {
    throw new Error('contained_execution_run_failed')
  }

  const receipt: ContainedExecutionReceipt = {
    version: 1,
    imageId,
    mirrorBackend: params.mirror.backend,
    networkMode: 'none',
    readOnlyRoot: true,
    tmpfsPath: '/tmp',
    tmpfsSizeBytes: TMPFS_SIZE_BYTES,
    tmpfsExec: false,
    capDrop: 'ALL',
    noNewPrivileges: true,
    memoryBytes: resourceLimits.memoryMiB * 1024 * 1024,
    nanoCpus: Math.round(resourceLimits.cpus * 1_000_000_000),
    pidsLimit: resourceLimits.pids,
    user,
    entrypoint: '/bin/sh',
    proxyEnvironment: 'neutralized-empty',
    guestWorkspacePath: params.mirror.guestWorkspacePath,
    guestCwd,
    exitCode: run.exitCode,
    timedOut: run.timedOut,
  }
  return { ...run, receipt, receiptHash: hashValue(canonicalStringify(receipt)) }
}

export async function probeContainedDockerForSession(params: {
  repoRoot: string
  config: BelayContainedExecutionConfig
  dependencies?: ContainedDockerDependencies
}): Promise<BoundaryAttestation> {
  if (!params.config.enabled || !params.config.image) {
    throw new Error('contained_execution_disabled')
  }
  const probeRoot = await mkdtemp(path.join(os.tmpdir(), 'belay-contained-probe-'))
  let probeError: unknown
  let capability: ContainedExecutionAttestation | undefined
  try {
    capability = await probeContainedDockerBoundary({
      imageReference: params.config.image,
      hostProbeRoot: probeRoot,
      guestWorkspacePath: path.resolve(params.repoRoot),
      resourceLimits: resourceLimitsFromConfig(params.config),
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
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error
    }
  }
  if (probeError) {
    throw probeError
  }
  if (!capability) {
    throw new Error('contained_execution_probe_failed')
  }
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
