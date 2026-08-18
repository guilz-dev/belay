import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import type { BoundaryAttestation } from '../core/capability/attestation.js'
import { signBoundaryAttestation } from '../core/capability/boundary-attestation-sign.js'
import { startBoundarySession } from '../core/capability/boundary-session.js'
import { type BelayContainedExecutionConfig, DEFAULT_CONFIG_V4 } from '../core/config.js'
import {
  buildContainedDockerArgs,
  type ContainedDockerDependencies,
  type ContainedDockerInspect,
  executeContainedDocker,
  probeContainedDockerBoundary,
} from '../core/contained-execution/docker.js'
import type { ContainedExecutionMirrorHandle } from '../core/contained-execution/mirror.js'
import type { ShellRunResult } from '../core/process-runner.js'

const imageId = `sha256:${'a'.repeat(64)}`
const otherImageId = `sha256:${'b'.repeat(64)}`
const now = Date.parse('2026-08-18T10:00:00.000Z')
const config = {
  enabled: true,
  image: 'local/runner:task4',
  timeoutMs: 30_000,
  memoryMiB: 512,
  cpus: 1.5,
  pids: 64,
} satisfies BelayContainedExecutionConfig

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

function containerInspect(params: {
  hostRoot: string
  guestRoot: string
  cwd: string
  command?: string
}): ContainedDockerInspect {
  return {
    Id: 'probe-container-id',
    Image: imageId,
    Config: {
      User: '501:20',
      Env: [
        'PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
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
      Cmd: ['-c', params.command ?? ':'],
      WorkingDir: params.cwd,
    },
    HostConfig: {
      NetworkMode: 'none',
      ReadonlyRootfs: true,
      Tmpfs: { '/tmp': 'rw,nosuid,nodev,noexec,size=67108864,mode=1777' },
      CapDrop: ['ALL'],
      SecurityOpt: ['no-new-privileges'],
      Memory: 536_870_912,
      NanoCpus: 1_500_000_000,
      PidsLimit: 64,
      Devices: [],
      Binds: [],
      ExtraHosts: [],
    },
    Mounts: [
      {
        Type: 'bind',
        Source: params.hostRoot,
        Destination: params.guestRoot,
        RW: true,
      },
    ],
  }
}

function fakeDependencies(params: {
  hostRoot: string
  guestRoot: string
  cwd: string
  image?: string
  inspect?: ContainedDockerInspect
  runResult?: ShellRunResult
  cleanupInspectResult?: ShellRunResult
}): ContainedDockerDependencies & { calls: string[][] } {
  const calls: string[][] = []
  let containerInspectCount = 0
  return {
    calls,
    now: () => now,
    randomUUID: () => '123e4567-e89b-42d3-a456-426614174000',
    uid: () => 501,
    gid: () => 20,
    async runDocker(args) {
      calls.push(args)
      if (args[0] === 'image') {
        return result({
          stdout: JSON.stringify([
            {
              Id: params.image ?? imageId,
              Config: {
                Env: [
                  'PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
                  'IMAGE_DEFINED=yes',
                ],
              },
            },
          ]),
        })
      }
      if (args[0] === 'create') {
        return result({ stdout: 'probe-container-id\n' })
      }
      if (args[0] === 'run') {
        return params.runResult ?? result({ stdout: 'ok' })
      }
      if (args[0] === 'start') {
        return result()
      }
      if (args[0] === 'rm') {
        return result()
      }
      if (args[0] === 'inspect') {
        containerInspectCount += 1
        if (containerInspectCount === 1 && params.inspect) {
          return result({ stdout: JSON.stringify([params.inspect]) })
        }
        return (
          params.cleanupInspectResult ??
          result({ exitCode: 1, stderr: 'Error: No such container: belay-contained' })
        )
      }
      throw new Error(`unexpected docker args: ${args.join(' ')}`)
    },
  }
}

function attestation(overrides: Partial<BoundaryAttestation> = {}): BoundaryAttestation {
  const probedAt = new Date(now - 1_000).toISOString()
  return {
    version: 1,
    driver: 'container',
    probedAt,
    expiresAt: new Date(now + 60_000).toISOString(),
    deniesUngrantedEffects: false,
    materializesGrants: false,
    probeSignals: ['docker', 'contained-execution'],
    containedExecution: {
      version: 1,
      imageId,
      networkNone: true,
      isolatesWorkspaceMirror: true,
      readOnlyRoot: true,
      sanitizedEnvironment: true,
      user: '501:20',
      entrypoint: '/bin/sh',
      capDropAll: true,
      noNewPrivileges: true,
      proxyEnvironment: 'neutralized-empty',
      tmpfs: {
        path: '/tmp',
        sizeBytes: 67_108_864,
        mode: 0o1777,
        exec: false,
        nosuid: true,
        nodev: true,
      },
      resourceLimits: {
        timeoutMs: config.timeoutMs,
        memoryMiB: config.memoryMiB,
        cpus: config.cpus,
        pids: config.pids,
      },
      probedAt,
      expiresAt: new Date(now + 60_000).toISOString(),
    },
    ...overrides,
  }
}

describe('contained Docker execution', () => {
  const tempRoots: string[] = []

  afterEach(async () => {
    await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
  })

  async function mirror(): Promise<ContainedExecutionMirrorHandle> {
    const parent = await mkdtemp(path.join(os.tmpdir(), 'belay-contained-docker-test-'))
    tempRoots.push(parent)
    const hostMirrorRoot = path.join(parent, 'mirror')
    await mkdir(path.join(hostMirrorRoot, 'sub'), { recursive: true })
    return {
      hostMirrorRoot,
      guestWorkspacePath: '/workspace/project',
      backend: 'file_copy',
      async cleanup() {},
    }
  }

  it('builds the exact hardened argv with one writable mirror and no host env or egress path', () => {
    expect(
      buildContainedDockerArgs({
        operation: 'run',
        containerName: 'belay-contained-123e4567-e89b-42d3-a456-426614174000',
        imageId,
        command: 'fictional-runner check',
        hostMirrorRoot: '/private/tmp/mirror',
        guestWorkspacePath: '/workspace/project',
        guestCwd: '/workspace/project/sub',
        resourceLimits: config,
        user: '501:20',
      }),
    ).toEqual([
      'run',
      '--rm',
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
      '--memory',
      '512m',
      '--cpus',
      '1.5',
      '--pids-limit',
      '64',
      '--user',
      '501:20',
      '--env',
      'HTTP_PROXY=',
      '--env',
      'HTTPS_PROXY=',
      '--env',
      'ALL_PROXY=',
      '--env',
      'NO_PROXY=',
      '--env',
      'http_proxy=',
      '--env',
      'https_proxy=',
      '--env',
      'all_proxy=',
      '--env',
      'no_proxy=',
      '--mount',
      'type=bind,src=/private/tmp/mirror,dst=/workspace/project',
      '--workdir',
      '/workspace/project/sub',
      '--entrypoint',
      '/bin/sh',
      imageId,
      '-c',
      'fictional-runner check',
    ])
  })

  it('resolves a local image, probes inspect properties from the shared builder, and cleans up', async () => {
    const handle = await mirror()
    const dependencies = fakeDependencies({
      hostRoot: handle.hostMirrorRoot,
      guestRoot: handle.guestWorkspacePath,
      cwd: handle.guestWorkspacePath,
      inspect: containerInspect({
        hostRoot: handle.hostMirrorRoot,
        guestRoot: handle.guestWorkspacePath,
        cwd: handle.guestWorkspacePath,
      }),
    })

    const capability = await probeContainedDockerBoundary({
      imageReference: config.image ?? '',
      guestWorkspacePath: handle.guestWorkspacePath,
      hostProbeRoot: handle.hostMirrorRoot,
      resourceLimits: config,
      dependencies,
    })

    expect(capability.imageId).toBe(imageId)
    expect(capability.resourceLimits).toEqual({
      timeoutMs: 30_000,
      memoryMiB: 512,
      cpus: 1.5,
      pids: 64,
    })
    expect(capability).toMatchObject({
      user: '501:20',
      entrypoint: '/bin/sh',
      capDropAll: true,
      noNewPrivileges: true,
      proxyEnvironment: 'neutralized-empty',
      tmpfs: {
        path: '/tmp',
        sizeBytes: 67_108_864,
        mode: 0o1777,
        exec: false,
        nosuid: true,
        nodev: true,
      },
    })
    expect(dependencies.calls[0]).toEqual(['image', 'inspect', config.image])
    expect(dependencies.calls.some((args) => args[0] === 'create')).toBe(true)
    expect(dependencies.calls.some((args) => args[0] === 'start')).toBe(true)
    expect(dependencies.calls.slice(-2).map((args) => args[0])).toEqual(['rm', 'inspect'])
  })

  it('fails probe closed on an inspect mismatch and still confirms container removal', async () => {
    const handle = await mirror()
    const inspected = containerInspect({
      hostRoot: handle.hostMirrorRoot,
      guestRoot: handle.guestWorkspacePath,
      cwd: handle.guestWorkspacePath,
    })
    inspected.HostConfig.NetworkMode = 'bridge'
    const dependencies = fakeDependencies({
      hostRoot: handle.hostMirrorRoot,
      guestRoot: handle.guestWorkspacePath,
      cwd: handle.guestWorkspacePath,
      inspect: inspected,
    })

    await expect(
      probeContainedDockerBoundary({
        imageReference: config.image ?? '',
        guestWorkspacePath: handle.guestWorkspacePath,
        hostProbeRoot: handle.hostMirrorRoot,
        resourceLimits: config,
        dependencies,
      }),
    ).rejects.toThrow('contained_execution_probe_mismatch')
    expect(dependencies.calls.slice(-2).map((args) => args[0])).toEqual(['rm', 'inspect'])
  })

  it.each([
    [
      'read-only root',
      (value: ContainedDockerInspect) => (value.HostConfig.ReadonlyRootfs = false),
    ],
    [
      'mount graph',
      (value: ContainedDockerInspect) => {
        const mount = value.Mounts[0]
        if (mount) value.Mounts.push({ ...mount })
      },
    ],
    ['tmpfs', (value: ContainedDockerInspect) => (value.HostConfig.Tmpfs = null)],
    ['capabilities', (value: ContainedDockerInspect) => (value.HostConfig.CapDrop = [])],
    ['security opts', (value: ContainedDockerInspect) => (value.HostConfig.SecurityOpt = [])],
    ['memory', (value: ContainedDockerInspect) => (value.HostConfig.Memory = 1)],
    ['cpu', (value: ContainedDockerInspect) => (value.HostConfig.NanoCpus = 1)],
    ['pids', (value: ContainedDockerInspect) => (value.HostConfig.PidsLimit = 1)],
    ['user', (value: ContainedDockerInspect) => (value.Config.User = '0:0')],
    ['entrypoint', (value: ContainedDockerInspect) => (value.Config.Entrypoint = ['/bin/bash'])],
    ['working directory', (value: ContainedDockerInspect) => (value.Config.WorkingDir = '/')],
    ['devices', (value: ContainedDockerInspect) => (value.HostConfig.Devices = [{}])],
    ['legacy binds', (value: ContainedDockerInspect) => (value.HostConfig.Binds = ['/:/host'])],
  ])('fails probe closed when inspect changes %s', async (_label, mutate) => {
    const handle = await mirror()
    const inspected = containerInspect({
      hostRoot: handle.hostMirrorRoot,
      guestRoot: handle.guestWorkspacePath,
      cwd: handle.guestWorkspacePath,
    })
    mutate(inspected)
    const dependencies = fakeDependencies({
      hostRoot: handle.hostMirrorRoot,
      guestRoot: handle.guestWorkspacePath,
      cwd: handle.guestWorkspacePath,
      inspect: inspected,
    })

    await expect(
      probeContainedDockerBoundary({
        imageReference: config.image ?? '',
        guestWorkspacePath: handle.guestWorkspacePath,
        hostProbeRoot: handle.hostMirrorRoot,
        resourceLimits: config,
        dependencies,
      }),
    ).rejects.toThrow('contained_execution_probe_mismatch')
  })

  it('fails probe closed when container removal cannot be confirmed', async () => {
    const handle = await mirror()
    const dependencies = fakeDependencies({
      hostRoot: handle.hostMirrorRoot,
      guestRoot: handle.guestWorkspacePath,
      cwd: handle.guestWorkspacePath,
      inspect: containerInspect({
        hostRoot: handle.hostMirrorRoot,
        guestRoot: handle.guestWorkspacePath,
        cwd: handle.guestWorkspacePath,
      }),
      cleanupInspectResult: result({ stdout: '[{"Id":"still-present"}]' }),
    })

    await expect(
      probeContainedDockerBoundary({
        imageReference: config.image ?? '',
        guestWorkspacePath: handle.guestWorkspacePath,
        hostProbeRoot: handle.hostMirrorRoot,
        resourceLimits: config,
        dependencies,
      }),
    ).rejects.toThrow('contained_execution_container_cleanup_unconfirmed')
  })

  it('fails probe closed when inspect does not bind the created container to the immutable ID', async () => {
    const handle = await mirror()
    const inspected = containerInspect({
      hostRoot: handle.hostMirrorRoot,
      guestRoot: handle.guestWorkspacePath,
      cwd: handle.guestWorkspacePath,
    })
    delete (inspected as { Image?: string }).Image
    const dependencies = fakeDependencies({
      hostRoot: handle.hostMirrorRoot,
      guestRoot: handle.guestWorkspacePath,
      cwd: handle.guestWorkspacePath,
      inspect: inspected,
    })

    await expect(
      probeContainedDockerBoundary({
        imageReference: config.image ?? '',
        guestWorkspacePath: handle.guestWorkspacePath,
        hostProbeRoot: handle.hostMirrorRoot,
        resourceLimits: config,
        dependencies,
      }),
    ).rejects.toThrow('contained_execution_probe_mismatch')
  })

  it('allows image-defined env but rejects any container env not derived from the image or proxy neutralization', async () => {
    const handle = await mirror()
    const inspected = containerInspect({
      hostRoot: handle.hostMirrorRoot,
      guestRoot: handle.guestWorkspacePath,
      cwd: handle.guestWorkspacePath,
    })
    inspected.Config.Env?.push('HOST_TOKEN=injected')
    const dependencies = fakeDependencies({
      hostRoot: handle.hostMirrorRoot,
      guestRoot: handle.guestWorkspacePath,
      cwd: handle.guestWorkspacePath,
      inspect: inspected,
    })

    await expect(
      probeContainedDockerBoundary({
        imageReference: config.image ?? '',
        guestWorkspacePath: handle.guestWorkspacePath,
        hostProbeRoot: handle.hostMirrorRoot,
        resourceLimits: config,
        dependencies,
      }),
    ).rejects.toThrow('contained_execution_probe_mismatch')
  })

  it('adds only the contained capability during session start when the feature is enabled', async () => {
    const repoRoot = await mkdtemp(path.join(os.tmpdir(), 'belay-contained-session-'))
    tempRoots.push(repoRoot)
    let inspectCount = 0
    let createArgs: string[] = []
    const dependencies: ContainedDockerDependencies = {
      now: () => now,
      randomUUID: () => '123e4567-e89b-42d3-a456-426614174000',
      uid: () => 501,
      gid: () => 20,
      async runDocker(args) {
        if (args[0] === 'image') {
          return result({
            stdout: JSON.stringify([
              {
                Id: imageId,
                Config: {
                  Env: [
                    'PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
                    'IMAGE_DEFINED=yes',
                  ],
                },
              },
            ]),
          })
        }
        if (args[0] === 'create') {
          createArgs = args
          return result({ stdout: 'probe-container-id\n' })
        }
        if (args[0] === 'inspect') {
          inspectCount += 1
          if (inspectCount === 1) {
            const mountSpec = createArgs[createArgs.indexOf('--mount') + 1] ?? ''
            const source = mountSpec.match(/src=([^,]+)/)?.[1] ?? ''
            return result({
              stdout: JSON.stringify([
                containerInspect({
                  hostRoot: source,
                  guestRoot: repoRoot,
                  cwd: repoRoot,
                }),
              ]),
            })
          }
          return result({ exitCode: 1, stderr: 'No such container' })
        }
        return result()
      },
    }
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
      containedDockerDependencies: dependencies,
    })

    expect(started.attestation).toMatchObject({
      driver: 'container',
      deniesUngrantedEffects: false,
      materializesGrants: false,
      containedExecution: { imageId, networkNone: true },
    })
    const signed = JSON.parse(await readFile(started.attestationPath, 'utf8'))
    expect(signed.attestation.containedExecution.imageId).toBe(imageId)
  })

  it('rejects missing, stale, tampered, legacy, image-mismatched, and limit-mismatched capabilities', async () => {
    const handle = await mirror()
    const controlPlaneDir = await mkdtemp(path.join(os.tmpdir(), 'belay-contained-signing-'))
    tempRoots.push(controlPlaneDir)
    const valid = await signBoundaryAttestation({
      repoRoot: handle.guestWorkspacePath,
      attestation: attestation(),
      controlPlaneDir,
    })
    const validCapability = valid.attestation.containedExecution
    const currentCapability = attestation().containedExecution
    if (!validCapability || !currentCapability) {
      throw new Error('test fixture is missing contained capability')
    }
    const base = {
      repoRoot: handle.guestWorkspacePath,
      controlPlaneDir,
      config,
      mirror: handle,
      guestCwd: handle.guestWorkspacePath,
      command: 'fictional-runner check',
    }
    const deps = fakeDependencies({
      hostRoot: handle.hostMirrorRoot,
      guestRoot: handle.guestWorkspacePath,
      cwd: handle.guestWorkspacePath,
    })

    for (const [label, signedAttestation, runConfig, resolvedImage] of [
      ['missing', undefined, config, imageId],
      ['legacy', attestation(), config, imageId],
      [
        'non-container',
        await signBoundaryAttestation({
          repoRoot: handle.guestWorkspacePath,
          attestation: {
            ...attestation(),
            driver: 'host-integration',
            containedExecution: undefined,
          },
          controlPlaneDir,
        }),
        config,
        imageId,
      ],
      [
        'tampered',
        {
          ...valid,
          attestation: {
            ...valid.attestation,
            containedExecution: { ...validCapability, imageId: otherImageId },
          },
        },
        config,
        imageId,
      ],
      [
        'stale',
        await signBoundaryAttestation({
          repoRoot: handle.guestWorkspacePath,
          attestation: attestation({
            containedExecution: {
              ...currentCapability,
              expiresAt: new Date(now - 1).toISOString(),
            },
          }),
          controlPlaneDir,
        }),
        config,
        imageId,
      ],
      [
        'stale signed envelope',
        await signBoundaryAttestation({
          repoRoot: handle.guestWorkspacePath,
          attestation: {
            ...attestation(),
            expiresAt: new Date(now - 1).toISOString(),
          },
          controlPlaneDir,
        }),
        config,
        imageId,
      ],
      ['image mismatch', valid, config, otherImageId],
      ['limit mismatch', valid, { ...config, pids: 65 }, imageId],
      [
        'fixed policy mismatch',
        await signBoundaryAttestation({
          repoRoot: handle.guestWorkspacePath,
          attestation: {
            ...attestation(),
            containedExecution: {
              ...currentCapability,
              tmpfs: { ...currentCapability.tmpfs, sizeBytes: 1 },
            },
          },
          controlPlaneDir,
        }),
        config,
        imageId,
      ],
    ] as const) {
      const localDeps = {
        ...deps,
        ...fakeDependencies({
          hostRoot: handle.hostMirrorRoot,
          guestRoot: handle.guestWorkspacePath,
          cwd: handle.guestWorkspacePath,
          image: resolvedImage,
        }),
      }
      await expect(
        executeContainedDocker({
          ...base,
          config: runConfig,
          signedAttestation,
          dependencies: localDeps,
        }),
        label,
      ).rejects.toThrow()
    }
  })

  it('rejects a configured image reference that is not present locally without pulling', async () => {
    const handle = await mirror()
    const controlPlaneDir = await mkdtemp(path.join(os.tmpdir(), 'belay-contained-signing-'))
    tempRoots.push(controlPlaneDir)
    const signedAttestation = await signBoundaryAttestation({
      repoRoot: handle.guestWorkspacePath,
      attestation: attestation(),
      controlPlaneDir,
    })
    const dependencies = fakeDependencies({
      hostRoot: handle.hostMirrorRoot,
      guestRoot: handle.guestWorkspacePath,
      cwd: handle.guestWorkspacePath,
    })
    dependencies.runDocker = async (args) => {
      dependencies.calls.push(args)
      return result({ exitCode: 1, stderr: 'No such image' })
    }

    await expect(
      executeContainedDocker({
        repoRoot: handle.guestWorkspacePath,
        controlPlaneDir,
        config,
        mirror: handle,
        guestCwd: handle.guestWorkspacePath,
        command: 'true',
        signedAttestation,
        dependencies,
      }),
    ).rejects.toThrow('contained_execution_image_missing')
    expect(dependencies.calls).toEqual([['image', 'inspect', config.image]])
  })

  it('runs the command once by immutable ID and returns bounded output with a deterministic receipt', async () => {
    const handle = await mirror()
    const controlPlaneDir = await mkdtemp(path.join(os.tmpdir(), 'belay-contained-signing-'))
    tempRoots.push(controlPlaneDir)
    const signedAttestation = await signBoundaryAttestation({
      repoRoot: handle.guestWorkspacePath,
      attestation: attestation(),
      controlPlaneDir,
    })
    const dependencies = fakeDependencies({
      hostRoot: handle.hostMirrorRoot,
      guestRoot: handle.guestWorkspacePath,
      cwd: `${handle.guestWorkspacePath}/sub`,
      runResult: result({
        exitCode: 7,
        stdout: 'tail',
        stderr: 'error tail',
        stdoutTruncated: true,
      }),
    })

    const executed = await executeContainedDocker({
      repoRoot: handle.guestWorkspacePath,
      controlPlaneDir,
      config,
      mirror: handle,
      guestCwd: `${handle.guestWorkspacePath}/sub`,
      command: 'fictional-runner check',
      signedAttestation,
      dependencies,
    })

    expect(dependencies.calls.filter((args) => args[0] === 'run')).toHaveLength(1)
    expect(dependencies.calls.find((args) => args[0] === 'run')).toContain(imageId)
    expect(dependencies.calls.find((args) => args[0] === 'run')).not.toContain(config.image)
    expect(executed).toMatchObject({
      exitCode: 7,
      timedOut: false,
      stdout: 'tail',
      stderr: 'error tail',
      stdoutTruncated: true,
      receipt: {
        version: 1,
        imageId,
        mirrorBackend: 'file_copy',
        networkMode: 'none',
        tmpfsExec: false,
        exitCode: 7,
        timedOut: false,
      },
    })
    expect(executed.receipt).not.toHaveProperty('stdout')
    expect(executed.receipt).not.toHaveProperty('stderr')
    expect(executed.receiptHash).toMatch(/^[a-f0-9]{64}$/)

    const differentOutputDependencies = fakeDependencies({
      hostRoot: handle.hostMirrorRoot,
      guestRoot: handle.guestWorkspacePath,
      cwd: `${handle.guestWorkspacePath}/sub`,
      runResult: result({ exitCode: 7, stdout: 'different', stderr: 'also different' }),
    })
    const sameEnforcement = await executeContainedDocker({
      repoRoot: handle.guestWorkspacePath,
      controlPlaneDir,
      config,
      mirror: handle,
      guestCwd: `${handle.guestWorkspacePath}/sub`,
      command: 'fictional-runner check',
      signedAttestation,
      dependencies: differentOutputDependencies,
    })
    expect(sameEnforcement.receiptHash).toBe(executed.receiptHash)
  })

  it('rejects a runtime host identity that differs from the identity probed for the capability', async () => {
    const handle = await mirror()
    const controlPlaneDir = await mkdtemp(path.join(os.tmpdir(), 'belay-contained-signing-'))
    tempRoots.push(controlPlaneDir)
    const signedAttestation = await signBoundaryAttestation({
      repoRoot: handle.guestWorkspacePath,
      attestation: attestation(),
      controlPlaneDir,
    })
    const dependencies = fakeDependencies({
      hostRoot: handle.hostMirrorRoot,
      guestRoot: handle.guestWorkspacePath,
      cwd: handle.guestWorkspacePath,
    })
    dependencies.uid = () => 502

    await expect(
      executeContainedDocker({
        repoRoot: handle.guestWorkspacePath,
        controlPlaneDir,
        config,
        mirror: handle,
        guestCwd: handle.guestWorkspacePath,
        command: 'true',
        signedAttestation,
        dependencies,
      }),
    ).rejects.toThrow('contained_execution_capability_mismatch')
    expect(dependencies.calls.filter((args) => args[0] === 'run')).toHaveLength(0)
  })

  it('cleans up timed-out and failed containers and fails closed when absence is unconfirmed', async () => {
    const handle = await mirror()
    const controlPlaneDir = await mkdtemp(path.join(os.tmpdir(), 'belay-contained-signing-'))
    tempRoots.push(controlPlaneDir)
    const signedAttestation = await signBoundaryAttestation({
      repoRoot: handle.guestWorkspacePath,
      attestation: attestation(),
      controlPlaneDir,
    })
    const base = {
      repoRoot: handle.guestWorkspacePath,
      controlPlaneDir,
      config,
      mirror: handle,
      guestCwd: handle.guestWorkspacePath,
      command: 'fictional-runner check',
      signedAttestation,
    }

    for (const runResult of [result({ timedOut: true, exitCode: null }), result({ exitCode: 9 })]) {
      const dependencies = fakeDependencies({
        hostRoot: handle.hostMirrorRoot,
        guestRoot: handle.guestWorkspacePath,
        cwd: handle.guestWorkspacePath,
        runResult,
      })
      await executeContainedDocker({ ...base, dependencies })
      expect(dependencies.calls.slice(-2).map((args) => args[0])).toEqual(['rm', 'inspect'])
    }

    const dependencies = fakeDependencies({
      hostRoot: handle.hostMirrorRoot,
      guestRoot: handle.guestWorkspacePath,
      cwd: handle.guestWorkspacePath,
      runResult: result({ timedOut: true, exitCode: null }),
      cleanupInspectResult: result({ stdout: '[{"Id":"still-present"}]' }),
    })
    await expect(executeContainedDocker({ ...base, dependencies })).rejects.toThrow(
      'contained_execution_container_cleanup_unconfirmed',
    )
  })

  it('rejects invalid mount/cwd paths and any extra mount or env option before Docker execution', async () => {
    const handle = await mirror()
    const controlPlaneDir = await mkdtemp(path.join(os.tmpdir(), 'belay-contained-signing-'))
    tempRoots.push(controlPlaneDir)
    const signedAttestation = await signBoundaryAttestation({
      repoRoot: handle.guestWorkspacePath,
      attestation: attestation(),
      controlPlaneDir,
    })
    const dependencies = fakeDependencies({
      hostRoot: handle.hostMirrorRoot,
      guestRoot: handle.guestWorkspacePath,
      cwd: handle.guestWorkspacePath,
    })
    const base = {
      repoRoot: handle.guestWorkspacePath,
      controlPlaneDir,
      config,
      mirror: handle,
      command: 'true',
      signedAttestation,
      dependencies,
    }

    await expect(
      executeContainedDocker({ ...base, guestCwd: '/workspace/outside' }),
    ).rejects.toThrow('contained_execution_invalid_cwd')
    await expect(
      executeContainedDocker({
        ...base,
        guestCwd: handle.guestWorkspacePath,
        env: { TOKEN: 'secret' },
      } as never),
    ).rejects.toThrow('contained_execution_unknown_option')
    await expect(
      executeContainedDocker({
        ...base,
        guestCwd: handle.guestWorkspacePath,
        mounts: ['/:/host'],
      } as never),
    ).rejects.toThrow('contained_execution_unknown_option')
    await expect(
      executeContainedDocker({
        ...base,
        config: { ...config, env: { TOKEN: 'secret' } },
        guestCwd: handle.guestWorkspacePath,
      } as never),
    ).rejects.toThrow('contained_execution_unknown_option')
    await expect(
      executeContainedDocker({
        ...base,
        mirror: { ...handle, mounts: ['/:/host'] },
        guestCwd: handle.guestWorkspacePath,
      } as never),
    ).rejects.toThrow('contained_execution_unknown_option')
    expect(dependencies.calls).toEqual([])
  })

  it('rejects a forged mirror handle that would mount the source workspace itself', async () => {
    const sourceRoot = await mkdtemp(path.join(os.tmpdir(), 'belay-contained-source-'))
    tempRoots.push(sourceRoot)
    const controlPlaneDir = await mkdtemp(path.join(os.tmpdir(), 'belay-contained-signing-'))
    tempRoots.push(controlPlaneDir)
    const signedAttestation = await signBoundaryAttestation({
      repoRoot: sourceRoot,
      attestation: attestation(),
      controlPlaneDir,
    })
    const forgedMirror: ContainedExecutionMirrorHandle = {
      hostMirrorRoot: sourceRoot,
      guestWorkspacePath: sourceRoot,
      backend: 'file_copy',
      async cleanup() {},
    }
    const dependencies = fakeDependencies({
      hostRoot: sourceRoot,
      guestRoot: sourceRoot,
      cwd: sourceRoot,
    })

    await expect(
      executeContainedDocker({
        repoRoot: sourceRoot,
        controlPlaneDir,
        config,
        mirror: forgedMirror,
        guestCwd: sourceRoot,
        command: 'true',
        signedAttestation,
        dependencies,
      }),
    ).rejects.toThrow('contained_execution_invalid_mount')
    expect(dependencies.calls).toEqual([])
  })
})
