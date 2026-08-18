import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import type {
  BoundaryAttestation,
  DockerSubstrateIdentity,
} from '../core/capability/attestation.js'
import { signBoundaryAttestation } from '../core/capability/boundary-attestation-sign.js'
import { boundarySessionStatus, startBoundarySession } from '../core/capability/boundary-session.js'
import { type BelayContainedExecutionConfig, DEFAULT_CONFIG_V4 } from '../core/config.js'
import {
  buildContainedDockerCreateArgs,
  ContainedDockerBoundaryUnavailableError,
  ContainedDockerCleanupUnconfirmedError,
  type ContainedDockerDependencies,
  type ContainedDockerInspect,
  ContainedDockerStartAttemptError,
  executeContainedDocker,
  probeContainedDockerBoundary,
} from '../core/contained-execution/docker.js'
import {
  type ContainedExecutionMirrorHandle,
  prepareContainedExecutionMirror,
} from '../core/contained-execution/mirror.js'
import type { ShellRunResult } from '../core/process-runner.js'

const imageId = `sha256:${'a'.repeat(64)}`
const otherImageId = `sha256:${'b'.repeat(64)}`
const containerId = 'c'.repeat(64)
const now = Date.parse('2026-08-18T10:00:00.000Z')
const substrate: DockerSubstrateIdentity = {
  binaryPath: '/real/docker',
  binarySha256: 'd'.repeat(64),
  endpoint: 'unix:///real/docker.sock',
  daemonId: 'local-daemon',
}
const config = {
  enabled: true,
  image: 'local/runner:task4',
  dockerExecutable: '/configured/docker',
  dockerHost: 'unix:///configured/docker.sock',
  timeoutMs: 30_000,
  memoryMiB: 512,
  cpus: 1.5,
  pids: 64,
} satisfies BelayContainedExecutionConfig
const minimalEnv = {
  DOCKER_CONFIG: '/var/empty/belay-docker-config',
  HOME: '/var/empty',
  LC_ALL: 'C',
  PATH: '/usr/bin:/bin',
}

function result(overrides: Partial<ShellRunResult> = {}): ShellRunResult {
  return {
    exitCode: 0,
    signal: null,
    timedOut: false,
    stdout: '',
    stderr: '',
    stdoutTruncated: false,
    stderrTruncated: false,
    ...overrides,
  }
}

function arg(args: string[], flag: string): string {
  return args[args.indexOf(flag) + 1] ?? ''
}

function inspectFor(createArgs: string[]): ContainedDockerInspect {
  const mount = arg(createArgs, '--mount')
  return {
    Id: containerId,
    Image: imageId,
    Config: {
      User: arg(createArgs, '--user'),
      Env: [
        'PATH=/usr/bin',
        'IMAGE_DEFINED=yes',
        'HTTP_PROXY=',
        'HTTPS_PROXY=',
        'ALL_PROXY=',
        'NO_PROXY=',
        'http_proxy=',
        'https_proxy=',
        'all_proxy=',
        'no_proxy=',
      ],
      Entrypoint: ['/bin/sh'],
      Cmd: ['-c', createArgs.at(-1) ?? ''],
      WorkingDir: arg(createArgs, '--workdir'),
      Healthcheck: { Test: ['NONE'] },
    },
    HostConfig: {
      AutoRemove: false,
      Privileged: false,
      CapAdd: [],
      CapDrop: ['ALL'],
      SecurityOpt: ['no-new-privileges'],
      LogConfig: { Type: 'none', Config: {} },
      Devices: [],
      DeviceRequests: [],
      DeviceCgroupRules: [],
      GroupAdd: [],
      VolumesFrom: [],
      Binds: [],
      PortBindings: {},
      PublishAllPorts: false,
      Links: [],
      ExtraHosts: [],
      Dns: [],
      DnsOptions: [],
      DnsSearch: [],
      NetworkMode: 'none',
      ReadonlyRootfs: true,
      Tmpfs: { '/tmp': 'rw,nosuid,nodev,noexec,size=67108864,mode=1777' },
      Memory: 512 * 1024 * 1024,
      MemorySwap: 512 * 1024 * 1024,
      ShmSize: 64 * 1024 * 1024,
      NanoCpus: 1_500_000_000,
      PidsLimit: 64,
      RestartPolicy: { Name: 'no', MaximumRetryCount: 0 },
      IpcMode: 'none',
      PidMode: '',
      UTSMode: '',
      UsernsMode: '',
      CgroupnsMode: 'private',
    },
    NetworkSettings: { Ports: {} },
    Mounts: [
      {
        Type: 'bind',
        Source: mount.match(/(?:^|,)src=([^,]+)/)?.[1] ?? '',
        Destination: mount.match(/(?:^|,)dst=([^,]+)/)?.[1] ?? '',
        RW: true,
      },
    ],
  }
}

function formattedInspect(value: ContainedDockerInspect): string {
  return JSON.stringify([
    value.Id,
    value.Image,
    value.Config.User,
    value.Config.Env,
    value.Config.Entrypoint,
    value.Config.Cmd,
    value.Config.WorkingDir,
    value.Config.Healthcheck,
    value.HostConfig.AutoRemove,
    value.HostConfig.Privileged,
    value.HostConfig.CapAdd,
    value.HostConfig.CapDrop,
    value.HostConfig.SecurityOpt,
    value.HostConfig.LogConfig,
    value.HostConfig.Devices,
    value.HostConfig.DeviceRequests,
    value.HostConfig.DeviceCgroupRules,
    value.HostConfig.GroupAdd,
    value.HostConfig.VolumesFrom,
    value.HostConfig.Binds,
    value.HostConfig.PortBindings,
    value.HostConfig.PublishAllPorts,
    value.HostConfig.Links,
    value.HostConfig.ExtraHosts,
    value.HostConfig.Dns,
    value.HostConfig.DnsOptions,
    value.HostConfig.DnsSearch,
    value.HostConfig.NetworkMode,
    value.HostConfig.ReadonlyRootfs,
    value.HostConfig.Tmpfs,
    value.HostConfig.Memory,
    value.HostConfig.MemorySwap,
    value.HostConfig.ShmSize,
    value.HostConfig.NanoCpus,
    value.HostConfig.PidsLimit,
    value.HostConfig.RestartPolicy,
    value.HostConfig.IpcMode,
    value.HostConfig.PidMode,
    value.HostConfig.UTSMode,
    value.HostConfig.UsernsMode,
    value.HostConfig.CgroupnsMode,
    value.NetworkSettings.Ports,
    value.Mounts,
  ])
}

interface Call {
  file: string
  args: string[]
  env: Record<string, string>
  timeoutMs: number
}

function fakeDependencies(
  options: {
    substrate?: DockerSubstrateIdentity
    imageId?: string
    imageMissing?: boolean
    create?: ShellRunResult
    inspect?: ShellRunResult
    start?: ShellRunResult
    startThrow?: boolean
    mutate?: (value: ContainedDockerInspect) => void
    cleanupPresent?: boolean
    cleanupThrow?: 'rm' | 'inspect'
    inspectTruncated?: boolean
    imageTruncated?: boolean
    oversizedMetadata?: boolean
  } = {},
): ContainedDockerDependencies & { calls: Call[] } {
  const calls: Call[] = []
  let createArgs: string[] = []
  let present = false
  return {
    calls,
    now: () => now,
    randomUUID: () => '123e4567-e89b-42d3-a456-426614174000',
    uid: () => 501,
    gid: () => 20,
    async resolveSubstrate() {
      return options.substrate ?? substrate
    },
    async runProcess(file, args, env, timeoutMs) {
      calls.push({ file, args, env, timeoutMs })
      const dockerArgs = args.slice(2)
      if (dockerArgs[0] === 'image') {
        if (options.imageMissing) return result({ exitCode: 1, stderr: 'missing' })
        const environment = ['PATH=/usr/bin', 'IMAGE_DEFINED=yes']
        return result({
          stdout: JSON.stringify([options.imageId ?? imageId, environment]),
          stdoutTruncated: options.imageTruncated === true,
        })
      }
      if (dockerArgs[0] === 'create') {
        createArgs = dockerArgs
        const created = options.create ?? result({ stdout: `${containerId}\n` })
        present = created.exitCode === 0 && !created.timedOut
        return created
      }
      if (dockerArgs[0] === 'inspect') {
        if (present) {
          if (options.inspect) return options.inspect
          const value = inspectFor(createArgs)
          if (options.oversizedMetadata) {
            ;(value.Config as typeof value.Config & { Labels: Record<string, string> }).Labels = {
              oversized: 'x'.repeat(64 * 1024),
            }
          }
          options.mutate?.(value)
          return result({
            stdout: formattedInspect(value),
            stdoutTruncated: options.inspectTruncated === true,
          })
        }
        if (options.cleanupThrow === 'inspect') throw new Error('inspect transport failed')
        if (options.cleanupPresent) return result({ stdout: JSON.stringify([{ Id: containerId }]) })
        return result({ exitCode: 1, stderr: `No such container: ${containerId}` })
      }
      if (dockerArgs[0] === 'start') {
        if (options.startThrow) throw new Error('start transport failed')
        return options.start ?? result({ stdout: 'guest tail' })
      }
      if (dockerArgs[0] === 'rm') {
        if (options.cleanupThrow === 'rm') throw new Error('rm transport failed')
        if (!options.cleanupPresent) present = false
        return result()
      }
      throw new Error(`unexpected Docker call: ${dockerArgs.join(' ')}`)
    },
  }
}

interface Fixture {
  repoRoot: string
  controlPlaneDir: string
  protectedRoots: string[]
  mirror: ContainedExecutionMirrorHandle
}

const roots: string[] = []
const mirrors: ContainedExecutionMirrorHandle[] = []

afterEach(async () => {
  await Promise.allSettled(mirrors.splice(0).map((mirror) => mirror.cleanup()))
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function fixture(): Promise<Fixture> {
  const repoRoot = await mkdtemp(path.join(os.tmpdir(), 'belay-contained-source-'))
  const controlPlaneDir = await mkdtemp(path.join(os.tmpdir(), 'belay-contained-control-'))
  roots.push(repoRoot, controlPlaneDir)
  await mkdir(path.join(repoRoot, 'sub'))
  await writeFile(path.join(repoRoot, 'input.txt'), 'input\n')
  const protectedRoots = [controlPlaneDir]
  const mirror = await prepareContainedExecutionMirror({
    sourceRoot: repoRoot,
    controlPlaneRoots: protectedRoots,
    limits: {
      maxFiles: 100,
      maxSourceBytes: 1024 * 1024,
      maxWorkspaceBytes: 1024 * 1024,
      prepareTimeoutMs: 10_000,
    },
  })
  mirrors.push(mirror)
  return { repoRoot, controlPlaneDir, protectedRoots, mirror }
}

function capability(overrides: Partial<BoundaryAttestation> = {}): BoundaryAttestation {
  const probedAt = new Date(now - 1_000).toISOString()
  return {
    version: 1,
    driver: 'container',
    probedAt,
    expiresAt: new Date(now + 60_000).toISOString(),
    deniesUngrantedEffects: false,
    materializesGrants: false,
    probeSignals: ['contained-execution'],
    containedExecution: {
      version: 1,
      imageId,
      imageReference: config.image ?? '',
      networkNone: true,
      isolatesWorkspaceMirror: true,
      readOnlyRoot: true,
      sanitizedEnvironment: true,
      dockerSubstrate: substrate,
      dockerConfiguration: {
        executable: config.dockerExecutable ?? '',
        host: config.dockerHost ?? '',
      },
      user: '501:20',
      entrypoint: '/bin/sh',
      capDropAll: true,
      noNewPrivileges: true,
      logDriver: 'none',
      proxyEnvironment: 'neutralized-empty',
      tmpfs: {
        path: '/tmp',
        sizeBytes: 67_108_864,
        mode: 0o1777,
        exec: false,
        nosuid: true,
        nodev: true,
      },
      memorySwapMiB: 512,
      shmSizeMiB: 64,
      healthcheckDisabled: true,
      privateNamespaces: true,
      privileged: false,
      devicesNone: true,
      resourceLimits: {
        timeoutMs: 30_000,
        memoryMiB: 512,
        cpus: 1.5,
        pids: 64,
      },
      probedAt,
      expiresAt: new Date(now + 60_000).toISOString(),
    },
    ...overrides,
  }
}

async function signed(value: Fixture, attestation = capability()): Promise<unknown> {
  return signBoundaryAttestation({
    repoRoot: value.repoRoot,
    attestation,
    controlPlaneDir: value.controlPlaneDir,
  })
}

function executionParams(value: Fixture, signedAttestation: unknown) {
  return {
    repoRoot: value.repoRoot,
    controlPlaneDir: value.controlPlaneDir,
    protectedRoots: value.protectedRoots,
    config,
    mirror: value.mirror,
    guestCwd: value.repoRoot,
    command: 'fictional-runner check',
    signedAttestation,
  }
}

describe('contained Docker execution hardening', () => {
  it('builds the exact create-only policy argv', () => {
    expect(
      buildContainedDockerCreateArgs({
        containerName: 'belay-contained-123e4567-e89b-42d3-a456-426614174000',
        imageId,
        command: 'fictional-runner check',
        hostMirrorRoot: '/private/tmp/mirror',
        guestWorkspacePath: '/workspace/project',
        guestCwd: '/workspace/project',
        resourceLimits: config,
        user: '501:20',
      }),
    ).toEqual([
      'create',
      '--name',
      'belay-contained-123e4567-e89b-42d3-a456-426614174000',
      '--network',
      'none',
      '--read-only',
      '--tmpfs',
      '/tmp:rw,nosuid,nodev,noexec,size=67108864,mode=1777',
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
      '512m',
      '--memory-swap',
      '512m',
      '--shm-size',
      '64m',
      '--cpus',
      '1.5',
      '--pids-limit',
      '64',
      '--user',
      '501:20',
      '--no-healthcheck',
      '--ipc',
      'none',
      '--cgroupns',
      'private',
      ...[
        'HTTP_PROXY',
        'HTTPS_PROXY',
        'ALL_PROXY',
        'NO_PROXY',
        'http_proxy',
        'https_proxy',
        'all_proxy',
        'no_proxy',
      ].flatMap((name) => ['--env', `${name}=`]),
      '--mount',
      'type=bind,src=/private/tmp/mirror,dst=/workspace/project',
      '--workdir',
      '/workspace/project',
      '--entrypoint',
      '/bin/sh',
      imageId,
      '-c',
      'fictional-runner check',
    ])
  })

  it('uses the verified absolute binary, local endpoint, and minimal child environment', async () => {
    const value = await fixture()
    const dependencies = fakeDependencies()
    const probed = await probeContainedDockerBoundary({
      repoRoot: value.repoRoot,
      protectedRoots: value.protectedRoots,
      imageReference: config.image ?? '',
      dockerExecutable: config.dockerExecutable ?? '',
      dockerHost: config.dockerHost ?? '',
      hostProbeRoot: value.mirror.hostMirrorRoot,
      guestWorkspacePath: value.repoRoot,
      resourceLimits: config,
      dependencies,
    })
    expect(probed.dockerSubstrate).toEqual(substrate)
    for (const call of dependencies.calls) {
      expect(call.file).toBe(substrate.binaryPath)
      expect(call.args.slice(0, 2)).toEqual(['--host', substrate.endpoint])
      expect(call.env).toEqual(minimalEnv)
    }
  })

  it('types a thrown probe start transport after recording the start attempt', async () => {
    const value = await fixture()
    const failure = await probeContainedDockerBoundary({
      repoRoot: value.repoRoot,
      protectedRoots: value.protectedRoots,
      imageReference: config.image ?? '',
      dockerExecutable: config.dockerExecutable ?? '',
      dockerHost: config.dockerHost ?? '',
      hostProbeRoot: value.mirror.hostMirrorRoot,
      guestWorkspacePath: value.repoRoot,
      resourceLimits: config,
      dependencies: fakeDependencies({ startThrow: true }),
    }).catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(ContainedDockerStartAttemptError)
    expect(failure).toMatchObject({ executionStarted: true })
  })

  it('reports probe cleanup uncertainty after a successful start as executionStarted', async () => {
    const value = await fixture()
    const failure = await probeContainedDockerBoundary({
      repoRoot: value.repoRoot,
      protectedRoots: value.protectedRoots,
      imageReference: config.image ?? '',
      dockerExecutable: config.dockerExecutable ?? '',
      dockerHost: config.dockerHost ?? '',
      hostProbeRoot: value.mirror.hostMirrorRoot,
      guestWorkspacePath: value.repoRoot,
      resourceLimits: config,
      dependencies: fakeDependencies({ cleanupPresent: true }),
    }).catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(ContainedDockerCleanupUnconfirmedError)
    expect(failure).toMatchObject({ executionStarted: true })
  })

  it.each([
    ['path', { binaryPath: '/other/docker' }],
    ['digest', { binarySha256: 'e'.repeat(64) }],
    ['socket', { endpoint: 'unix:///other.sock' }],
    ['daemon', { daemonId: 'other' }],
  ])('rejects substrate %s drift before Docker work', async (_name, drift) => {
    const value = await fixture()
    const dependencies = fakeDependencies({ substrate: { ...substrate, ...drift } })
    await expect(
      executeContainedDocker({
        ...executionParams(value, await signed(value)),
        dependencies,
      }),
    ).rejects.toMatchObject({ executionStarted: false })
    expect(dependencies.calls).toEqual([])
  })

  it('rejects forged, provenance-mismatched, and control-plane-overlapping mirrors', async () => {
    const value = await fixture()
    const signedAttestation = await signed(value)
    await expect(
      executeContainedDocker({
        ...executionParams(value, signedAttestation),
        mirror: { ...value.mirror },
        dependencies: fakeDependencies(),
      }),
    ).rejects.toThrow('contained_execution_invalid_mirror_lease')
    const omittedAdapterRoot = await mkdtemp(path.join(os.tmpdir(), 'belay-contained-adapter-'))
    roots.push(omittedAdapterRoot)
    await expect(
      executeContainedDocker({
        ...executionParams(value, signedAttestation),
        protectedRoots: [...value.protectedRoots, omittedAdapterRoot],
        dependencies: fakeDependencies(),
      }),
    ).rejects.toThrow('contained_execution_invalid_mirror_lease')
    const overlapSignature = await signBoundaryAttestation({
      repoRoot: value.repoRoot,
      attestation: capability(),
      controlPlaneDir: value.mirror.hostMirrorRoot,
    })
    await expect(
      executeContainedDocker({
        ...executionParams(value, overlapSignature),
        controlPlaneDir: value.mirror.hostMirrorRoot,
        dependencies: fakeDependencies(),
      }),
    ).rejects.toThrow('contained_execution_protected_root_overlap')
  })

  it('rejects a genuine lease that omitted a repo-local control-plane exclusion', async () => {
    const repoRoot = await mkdtemp(path.join(os.tmpdir(), 'belay-contained-local-control-'))
    roots.push(repoRoot)
    const controlPlaneDir = path.join(repoRoot, '.belay-control')
    await mkdir(controlPlaneDir)
    await writeFile(path.join(controlPlaneDir, 'attestation-signing-key.json'), 'secret\n')
    const mirror = await prepareContainedExecutionMirror({
      sourceRoot: repoRoot,
      controlPlaneRoots: [],
      limits: {
        maxFiles: 100,
        maxSourceBytes: 1024 * 1024,
        maxWorkspaceBytes: 1024 * 1024,
        prepareTimeoutMs: 10_000,
      },
    })
    mirrors.push(mirror)
    const dependencies = fakeDependencies()
    const signedAttestation = await signBoundaryAttestation({
      repoRoot,
      attestation: capability(),
      controlPlaneDir,
    })
    await expect(
      executeContainedDocker({
        repoRoot,
        controlPlaneDir,
        protectedRoots: [],
        config,
        mirror,
        guestCwd: repoRoot,
        command: 'fictional-runner check',
        signedAttestation,
        dependencies,
      }),
    ).rejects.toThrow('contained_execution_invalid_mirror_lease')
    expect(dependencies.calls).toEqual([])
  })

  it.each([
    ['create failure', { create: result({ exitCode: 125 }) }],
    ['create timeout', { create: result({ exitCode: null, timedOut: true }) }],
    ['inspect failure', { inspect: result({ exitCode: 1 }) }],
  ])('returns a typed pre-start error for %s', async (_name, options) => {
    const value = await fixture()
    const dependencies = fakeDependencies(options)
    const failure = await executeContainedDocker({
      ...executionParams(value, await signed(value)),
      dependencies,
    }).catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(ContainedDockerBoundaryUnavailableError)
    expect(failure).toMatchObject({ executionStarted: false, receipt: undefined })
    expect(dependencies.calls.filter((call) => call.args[2] === 'start')).toHaveLength(0)
  })

  it('uses a narrow formatted inspect that excludes oversized unselected metadata', async () => {
    const value = await fixture()
    const dependencies = fakeDependencies({ oversizedMetadata: true })
    await expect(
      executeContainedDocker({
        ...executionParams(value, await signed(value)),
        dependencies,
      }),
    ).resolves.toMatchObject({ executionStarted: true })
    const inspectCall = dependencies.calls.find((call) => call.args[2] === 'inspect')
    expect(inspectCall?.args).toContain('--format')
    expect(inspectCall?.args.join(' ')).not.toContain('Labels')
  })

  it('fails explicitly before start when selected inspect control output is truncated', async () => {
    const value = await fixture()
    const dependencies = fakeDependencies({ inspectTruncated: true })
    await expect(
      executeContainedDocker({
        ...executionParams(value, await signed(value)),
        dependencies,
      }),
    ).rejects.toMatchObject({
      executionStarted: false,
      reason: 'contained_execution_inspect_truncated',
    })
    expect(dependencies.calls.filter((call) => call.args[2] === 'start')).toHaveLength(0)
  })

  it('fails explicitly before create when selected image control output is truncated', async () => {
    const value = await fixture()
    const dependencies = fakeDependencies({ imageTruncated: true })
    await expect(
      executeContainedDocker({
        ...executionParams(value, await signed(value)),
        dependencies,
      }),
    ).rejects.toMatchObject({
      executionStarted: false,
      reason: 'contained_execution_image_inspect_truncated',
    })
    expect(dependencies.calls.filter((call) => call.args[2] === 'create')).toHaveLength(0)
  })

  it('creates, validates, starts exactly once by captured ID, and confirms cleanup', async () => {
    const value = await fixture()
    const dependencies = fakeDependencies({ start: result({ exitCode: 7, stdout: 'tail' }) })
    const executed = await executeContainedDocker({
      ...executionParams(value, await signed(value)),
      dependencies,
    })
    expect(dependencies.calls.map((call) => call.args[2])).toEqual([
      'image',
      'create',
      'inspect',
      'start',
      'rm',
      'inspect',
    ])
    expect(dependencies.calls.find((call) => call.args[2] === 'start')?.args).toEqual([
      '--host',
      substrate.endpoint,
      'start',
      '--attach',
      containerId,
    ])
    expect(executed).toMatchObject({ exitCode: 7, executionStarted: true })
  })

  it('never retries an ambiguous timed-out start', async () => {
    const value = await fixture()
    const dependencies = fakeDependencies({ start: result({ exitCode: null, timedOut: true }) })
    const executed = await executeContainedDocker({
      ...executionParams(value, await signed(value)),
      dependencies,
    })
    expect(executed).toMatchObject({ timedOut: true, executionStarted: true })
    expect(dependencies.calls.filter((call) => call.args[2] === 'start')).toHaveLength(1)
  })

  it('makes cleanup uncertainty dominant before and after start', async () => {
    const value = await fixture()
    for (const [create, executionStarted] of [
      [result({ exitCode: 125 }), false],
      [undefined, true],
    ] as const) {
      const dependencies = fakeDependencies({ create, cleanupPresent: true })
      const failure = await executeContainedDocker({
        ...executionParams(value, await signed(value)),
        dependencies,
      }).catch((error: unknown) => error)
      expect(failure).toBeInstanceOf(ContainedDockerCleanupUnconfirmedError)
      expect(failure).toMatchObject({ executionStarted })
    }
  })

  it.each([
    'rm',
    'inspect',
  ] as const)('types a cleanup %s transport exception as cleanup-unconfirmed', async (cleanupThrow) => {
    const value = await fixture()
    const failure = await executeContainedDocker({
      ...executionParams(value, await signed(value)),
      dependencies: fakeDependencies({ cleanupThrow }),
    }).catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(ContainedDockerCleanupUnconfirmedError)
    expect(failure).toMatchObject({ executionStarted: true })
  })

  const mutations: Array<[string, (value: ContainedDockerInspect) => void]> = [
    ['container id', (v) => (v.Id = 'e'.repeat(64))],
    ['image', (v) => (v.Image = otherImageId)],
    ['env', (v) => v.Config.Env?.push('HOST_TOKEN=secret')],
    ['user', (v) => (v.Config.User = '0:0')],
    ['entrypoint', (v) => (v.Config.Entrypoint = ['/bin/bash'])],
    ['cmd', (v) => (v.Config.Cmd = ['-c', 'other'])],
    ['workdir', (v) => (v.Config.WorkingDir = '/')],
    ['healthcheck', (v) => (v.Config.Healthcheck = null)],
    ['privileged', (v) => (v.HostConfig.Privileged = true)],
    ['cap add', (v) => (v.HostConfig.CapAdd = ['SYS_ADMIN'])],
    ['cap drop', (v) => (v.HostConfig.CapDrop = [])],
    ['security opt', (v) => (v.HostConfig.SecurityOpt = [])],
    ['default log driver', (v) => (v.HostConfig.LogConfig = { Type: 'json-file', Config: {} })],
    ['remote log driver', (v) => (v.HostConfig.LogConfig = { Type: 'fluentd', Config: {} })],
    ['log options', (v) => (v.HostConfig.LogConfig = { Type: 'none', Config: { tag: 'x' } })],
    ['null log config', (v) => (v.HostConfig.LogConfig = null)],
    ['device', (v) => (v.HostConfig.Devices = [{}])],
    ['device request', (v) => (v.HostConfig.DeviceRequests = [{}])],
    ['device rule', (v) => (v.HostConfig.DeviceCgroupRules = ['a'])],
    ['group', (v) => (v.HostConfig.GroupAdd = ['0'])],
    ['volumes from', (v) => (v.HostConfig.VolumesFrom = ['x'])],
    ['binds', (v) => (v.HostConfig.Binds = ['/x:/y'])],
    ['port binding', (v) => (v.HostConfig.PortBindings = { '80/tcp': [{}] })],
    ['publish ports', (v) => (v.HostConfig.PublishAllPorts = true)],
    ['links', (v) => (v.HostConfig.Links = ['x:y'])],
    ['extra hosts', (v) => (v.HostConfig.ExtraHosts = ['x:1.2.3.4'])],
    ['dns', (v) => (v.HostConfig.Dns = ['8.8.8.8'])],
    ['dns options', (v) => (v.HostConfig.DnsOptions = ['use-vc'])],
    ['dns search', (v) => (v.HostConfig.DnsSearch = ['example'])],
    ['network', (v) => (v.HostConfig.NetworkMode = 'bridge')],
    ['readonly', (v) => (v.HostConfig.ReadonlyRootfs = false)],
    ['tmpfs', (v) => (v.HostConfig.Tmpfs = {})],
    ['memory', (v) => (v.HostConfig.Memory += 1)],
    ['memory swap', (v) => (v.HostConfig.MemorySwap += 1)],
    ['shm', (v) => (v.HostConfig.ShmSize += 1)],
    ['cpu', (v) => (v.HostConfig.NanoCpus += 1)],
    ['pids', (v) => (v.HostConfig.PidsLimit = 65)],
    ['restart', (v) => (v.HostConfig.RestartPolicy.Name = 'always')],
    ['auto remove', (v) => (v.HostConfig.AutoRemove = true)],
    ['ipc', (v) => (v.HostConfig.IpcMode = 'host')],
    ['pid', (v) => (v.HostConfig.PidMode = 'host')],
    ['uts', (v) => (v.HostConfig.UTSMode = 'host')],
    ['userns', (v) => (v.HostConfig.UsernsMode = 'host')],
    ['cgroupns', (v) => (v.HostConfig.CgroupnsMode = 'host')],
    ['network ports', (v) => (v.NetworkSettings.Ports = { '80/tcp': [] })],
    ['mount cardinality', (v) => v.Mounts.push({ ...v.Mounts[0] })],
    ['mount rw', (v) => (v.Mounts[0].RW = false)],
    ['mount source', (v) => (v.Mounts[0].Source = '/other')],
    ['mount destination', (v) => (v.Mounts[0].Destination = '/other')],
  ]

  it.each(mutations)('rejects pre-start inspect drift in %s', async (_name, mutate) => {
    const value = await fixture()
    const dependencies = fakeDependencies({ mutate })
    const failure = await executeContainedDocker({
      ...executionParams(value, await signed(value)),
      dependencies,
    }).catch((error: unknown) => error)
    expect(failure).toMatchObject({ executionStarted: false })
    expect(dependencies.calls.filter((call) => call.args[2] === 'start')).toHaveLength(0)
  })

  it.each([
    ['stale', capability({ expiresAt: new Date(now - 1).toISOString() })],
    ['legacy', { ...capability(), containedExecution: undefined }],
    [
      'non-container',
      { ...capability(), driver: 'seatbelt' as const, containedExecution: undefined },
    ],
  ])('rejects %s signed attestation before Docker work', async (_name, attestation) => {
    const value = await fixture()
    const dependencies = fakeDependencies()
    await expect(
      executeContainedDocker({
        ...executionParams(value, await signed(value, attestation)),
        dependencies,
      }),
    ).rejects.toThrow('contained_execution_capability_invalid')
    expect(dependencies.calls).toEqual([])
  })

  it.each([
    ['primitive Docker substrate', { dockerSubstrate: 'x' }],
    ['null Docker substrate', { dockerSubstrate: null }],
    ['array Docker substrate', { dockerSubstrate: [] }],
    ['wrong-field Docker substrate', { dockerSubstrate: { ...substrate, binaryPath: 42 } }],
    ['primitive Docker configuration', { dockerConfiguration: 'x' }],
    ['null Docker configuration', { dockerConfiguration: null }],
    ['array Docker configuration', { dockerConfiguration: [] }],
    [
      'wrong-field Docker configuration',
      {
        dockerConfiguration: {
          executable: config.dockerExecutable,
          host: 42,
        },
      },
    ],
  ] as const)('rejects a signed malformed %s as capability-invalid before Docker work', async (_name, override) => {
    const value = await fixture()
    const base = capability()
    const malformed = {
      ...base,
      containedExecution: { ...base.containedExecution, ...override },
    } as unknown as BoundaryAttestation
    const dependencies = fakeDependencies()
    await expect(
      executeContainedDocker({
        ...executionParams(value, await signed(value, malformed)),
        dependencies,
      }),
    ).rejects.toThrow('contained_execution_capability_invalid')
    expect(dependencies.calls).toEqual([])
  })

  it('rejects tampering, missing image, and immutable image mismatch', async () => {
    const value = await fixture()
    const signedValue = (await signed(value)) as {
      attestation: BoundaryAttestation
      [key: string]: unknown
    }
    const tampered = {
      ...signedValue,
      attestation: {
        ...signedValue.attestation,
        containedExecution: {
          ...signedValue.attestation.containedExecution,
          imageId: otherImageId,
        },
      },
    }
    await expect(
      executeContainedDocker({
        ...executionParams(value, tampered),
        dependencies: fakeDependencies(),
      }),
    ).rejects.toThrow('contained_execution_capability_invalid')
    await expect(
      executeContainedDocker({
        ...executionParams(value, await signed(value)),
        dependencies: fakeDependencies({ imageMissing: true }),
      }),
    ).rejects.toMatchObject({ executionStarted: false })
    await expect(
      executeContainedDocker({
        ...executionParams(value, await signed(value)),
        dependencies: fakeDependencies({ imageId: otherImageId }),
      }),
    ).rejects.toThrow('contained_execution_image_mismatch')
  })

  it('returns complete command-separated privacy-preserving receipts', async () => {
    const value = await fixture()
    const envelope = await signed(value)
    const first = await executeContainedDocker({
      ...executionParams(value, envelope),
      command: 'runner first',
      dependencies: fakeDependencies(),
    })
    const second = await executeContainedDocker({
      ...executionParams(value, envelope),
      command: 'runner second',
      dependencies: fakeDependencies(),
    })
    expect(first.receiptHash).not.toBe(second.receiptHash)
    expect(first.receipt).toMatchObject({
      actionFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
      attestationDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
      executionStarted: true,
      timeoutMs: 30_000,
      dockerSubstrate: substrate,
      imageId,
      mirror: {
        backend: 'file_copy',
        cardinality: 1,
        readWrite: true,
        guestWorkspacePathFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
        guestCwdFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
      },
      logging: { driver: 'none', config: {} },
      tmpfs: { mode: 0o1777, nosuid: true, nodev: true, exec: false },
      environment: { hostForwarded: false, proxyEnvironment: 'neutralized-empty' },
      privilege: { privileged: false, capAdd: [], capDrop: ['ALL'] },
      devices: { devices: [], deviceRequests: [], deviceCgroupRules: [] },
      resources: { memoryMiB: 512, memorySwapMiB: 512, shmSizeMiB: 64, pids: 64 },
    })
    expect(first.receipt).not.toHaveProperty('command')
    expect(first.receipt).not.toHaveProperty('stdout')
    expect(first.receipt).not.toHaveProperty('stderr')
    const serialized = JSON.stringify(first.receipt)
    expect(serialized).not.toContain(value.repoRoot)
    expect(serialized).not.toContain(value.mirror.hostMirrorRoot)
  })

  it('signs and reports fresh contained execution without upgrading generic freshness', async () => {
    const repoRoot = await mkdtemp(path.join(os.tmpdir(), 'belay-contained-session-'))
    roots.push(repoRoot)
    const fullConfig = {
      ...DEFAULT_CONFIG_V4,
      sandbox: {
        ...DEFAULT_CONFIG_V4.sandbox,
        enabled: true,
        runtime: 'container' as const,
        containedExecution: config,
      },
    }
    const started = await startBoundarySession({
      repoRoot,
      config: fullConfig,
      containedDockerDependencies: fakeDependencies(),
    })
    expect(started.attestation).toMatchObject({
      deniesUngrantedEffects: false,
      materializesGrants: false,
      containedExecution: { dockerSubstrate: substrate },
    })
    expect(JSON.parse(await readFile(started.attestationPath, 'utf8'))).toHaveProperty(
      'attestation.containedExecution.dockerSubstrate.daemonId',
      substrate.daemonId,
    )
    const status = await boundarySessionStatus({ repoRoot, config: fullConfig, now })
    expect(status.fresh).toBe(false)
    expect(status.containedExecutionFresh).toBe(true)

    for (const containedExecution of [
      { ...config, enabled: false },
      { ...config, image: 'local/runner:other' },
      { ...config, timeoutMs: config.timeoutMs + 1 },
      { ...config, memoryMiB: config.memoryMiB + 1 },
      { ...config, cpus: config.cpus + 0.5 },
      { ...config, pids: config.pids + 1 },
      { ...config, dockerExecutable: '/other/docker' },
      { ...config, dockerHost: 'unix:///other/docker.sock' },
    ]) {
      const drifted = {
        ...fullConfig,
        sandbox: { ...fullConfig.sandbox, containedExecution },
      }
      const driftedStatus = await boundarySessionStatus({ repoRoot, config: drifted, now })
      expect(driftedStatus.fresh).toBe(false)
      expect(driftedStatus.containedExecutionFresh).toBe(false)
    }
  })
})
