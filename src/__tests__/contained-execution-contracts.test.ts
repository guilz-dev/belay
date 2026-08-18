import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import type {
  BoundaryAttestation,
  ContainedExecutionAttestation,
} from '../core/capability/attestation.js'
import {
  isContainedExecutionAttestationFresh,
  validateContainedExecutionAttestation,
} from '../core/capability/attestation.js'
import {
  signBoundaryAttestation,
  verifySignedBoundaryAttestation,
} from '../core/capability/boundary-attestation-sign.js'
import { isAttestedBoundary } from '../core/capability/boundary-profile.js'
import { DEFAULT_CONFIG_V3, migrateConfig, normalizeConfig } from '../core/config.js'
import { buildCapabilityEffectPlan } from '../core/effect-ir/build.js'
import { classifyResultToGateVerdict } from '../core/gate-contract.js'
import { runProcessWithBoundedOutput } from '../core/process-runner.js'

const future = '2099-01-01T00:00:00.000Z'
const past = '2000-01-01T00:00:00.000Z'
const containedCapability = {
  version: 1 as const,
  imageId: `sha256:${'a'.repeat(64)}`,
  networkNone: true,
  isolatesWorkspaceMirror: true,
  readOnlyRoot: true,
  sanitizedEnvironment: true,
  dockerSubstrate: {
    binaryPath: '/usr/local/bin/docker',
    binarySha256: 'd'.repeat(64),
    endpoint: 'unix:///var/run/docker.sock',
    daemonId: 'local-daemon',
  },
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
  memorySwapMiB: 2048,
  shmSizeMiB: 64,
  healthcheckDisabled: true,
  privateNamespaces: true,
  privileged: false,
  devicesNone: true,
  resourceLimits: { timeoutMs: 30_000, memoryMiB: 2048, cpus: 2, pids: 256 },
  probedAt: '2026-08-18T00:00:00.000Z',
  expiresAt: future,
} satisfies ContainedExecutionAttestation

function attestation(): BoundaryAttestation {
  return {
    version: 1,
    driver: 'container',
    probedAt: '2026-08-18T00:00:00.000Z',
    expiresAt: future,
    deniesUngrantedEffects: false,
    materializesGrants: false,
    probeSignals: ['contained-execution'],
    containedExecution: containedCapability,
  }
}

describe('contained unknown execution contracts', () => {
  let controlPlaneDir = ''

  afterEach(async () => {
    if (controlPlaneDir) {
      await rm(controlPlaneDir, { recursive: true, force: true })
      controlPlaneDir = ''
    }
  })

  it('normalizes opt-in contained execution defaults and migrates older config', () => {
    const migrated = migrateConfig({ version: 4 })
    expect(migrated.sandbox.containedExecution).toEqual({
      enabled: false,
      image: null,
      dockerExecutable: null,
      dockerHost: null,
      timeoutMs: 30_000,
      memoryMiB: 2048,
      cpus: 2,
      pids: 256,
    })

    const configured = normalizeConfig({
      ...DEFAULT_CONFIG_V3,
      sandbox: {
        enabled: true,
        runtime: 'container',
        denyNetworkByDefault: true,
        containedExecution: {
          enabled: true,
          image: 'registry.example/runner@sha256:abc',
          dockerExecutable: '/usr/local/bin/docker',
          dockerHost: 'unix:///var/run/docker.sock',
          timeoutMs: 5_000,
          memoryMiB: 512,
          cpus: 1,
          pids: 64,
        },
      },
    })
    expect(configured.sandbox.containedExecution).toMatchObject({
      enabled: true,
      image: 'registry.example/runner@sha256:abc',
      timeoutMs: 5_000,
      memoryMiB: 512,
      cpus: 1,
      pids: 64,
    })

    const fractionalCpu = normalizeConfig({
      ...DEFAULT_CONFIG_V3,
      sandbox: {
        enabled: true,
        runtime: 'container',
        denyNetworkByDefault: true,
        containedExecution: {
          enabled: true,
          image: 'registry.example/runner@sha256:abc',
          dockerExecutable: '/usr/local/bin/docker',
          dockerHost: 'unix:///var/run/docker.sock',
          timeoutMs: 5_000,
          memoryMiB: 512,
          cpus: 0.5,
          pids: 64,
        },
      },
    })
    expect(fractionalCpu.sandbox.containedExecution?.cpus).toBe(0.5)
    expect(
      validateContainedExecutionAttestation({
        ...containedCapability,
        resourceLimits: { ...containedCapability.resourceLimits, cpus: 0.5 },
      }),
    ).toBe(true)
  })

  it('rejects enabled contained execution without an enabled container runtime and image', () => {
    expect(() =>
      normalizeConfig({
        ...DEFAULT_CONFIG_V3,
        sandbox: {
          ...DEFAULT_CONFIG_V3.sandbox,
          containedExecution: { ...containedCapability.resourceLimits, enabled: true, image: null },
        },
      }),
    ).toThrow('contained execution requires sandbox.runtime=container')

    expect(() =>
      normalizeConfig({
        ...DEFAULT_CONFIG_V3,
        sandbox: {
          enabled: true,
          runtime: 'container',
          denyNetworkByDefault: true,
          containedExecution: { ...containedCapability.resourceLimits, enabled: true, image: null },
        },
      }),
    ).toThrow('contained execution requires an explicit image')

    for (const [extra, message] of [
      [{ dockerExecutable: null, dockerHost: 'unix:///var/run/docker.sock' }, 'executable'],
      [
        { dockerExecutable: 'docker', dockerHost: 'unix:///var/run/docker.sock' },
        'absolute executable',
      ],
      [{ dockerExecutable: '/usr/local/bin/docker', dockerHost: null }, 'Docker host'],
      [
        { dockerExecutable: '/usr/local/bin/docker', dockerHost: 'tcp://127.0.0.1:2375' },
        'local unix',
      ],
    ] as const) {
      expect(() =>
        normalizeConfig({
          ...DEFAULT_CONFIG_V3,
          sandbox: {
            enabled: true,
            runtime: 'container',
            denyNetworkByDefault: true,
            containedExecution: {
              ...containedCapability.resourceLimits,
              enabled: true,
              image: 'local/runner:task4',
              ...extra,
            },
          },
        }),
      ).toThrow(message)
    }
  })

  it('validates a fresh contained capability without upgrading it to L1-full', () => {
    const value = attestation()
    expect(validateContainedExecutionAttestation(value.containedExecution)).toBe(true)
    expect(isContainedExecutionAttestationFresh(value.containedExecution)).toBe(true)
    expect(value.materializesGrants).toBe(false)
    expect(value.deniesUngrantedEffects).toBe(false)
    expect(isAttestedBoundary(value)).toBe(false)
  })

  it('rejects stale and old contained capabilities', () => {
    expect(isContainedExecutionAttestationFresh({ ...containedCapability, expiresAt: past })).toBe(
      false,
    )
    expect(validateContainedExecutionAttestation({ ...containedCapability, version: 0 })).toBe(
      false,
    )
  })

  it('rejects a legacy contained capability without Docker substrate identity', () => {
    const legacy = { ...containedCapability } as Record<string, unknown>
    delete legacy.dockerSubstrate
    expect(validateContainedExecutionAttestation(legacy)).toBe(false)
  })

  it('rejects a contained capability probed in the future', () => {
    const now = Date.parse('2026-08-18T12:00:00.000Z')
    expect(
      isContainedExecutionAttestationFresh(
        {
          ...containedCapability,
          probedAt: new Date(now + 1).toISOString(),
          expiresAt: new Date(now + 60_000).toISOString(),
        },
        now,
      ),
    ).toBe(false)
  })

  it('rejects a tampered signed contained capability', async () => {
    controlPlaneDir = await mkdtemp(path.join(os.tmpdir(), 'belay-contained-attest-'))
    const signed = await signBoundaryAttestation({
      repoRoot: '/repo',
      attestation: attestation(),
      controlPlaneDir,
    })
    const verified = await verifySignedBoundaryAttestation({
      file: {
        ...signed,
        attestation: {
          ...signed.attestation,
          containedExecution: { ...containedCapability, imageId: `sha256:${'b'.repeat(64)}` },
        },
      },
      expectedRepoRoot: '/repo',
      controlPlaneDir,
    })
    expect(verified).toBeNull()
  })

  it('rejects a signed non-container attestation carrying a contained capability', async () => {
    controlPlaneDir = await mkdtemp(path.join(os.tmpdir(), 'belay-contained-attest-'))
    const signed = await signBoundaryAttestation({
      repoRoot: '/repo',
      attestation: { ...attestation(), driver: 'host-integration' },
      controlPlaneDir,
    })
    const verified = await verifySignedBoundaryAttestation({
      file: signed,
      expectedRepoRoot: '/repo',
      controlPlaneDir,
    })
    expect(verified).toBeNull()
  })

  it('keeps mediation fields optional in the gate verdict contract', () => {
    const effectPlan = buildCapabilityEffectPlan({
      actionKind: 'shell',
      summary: 'fictional-runner check',
      inputFingerprint: 'fp',
      requests: [],
      effectFree: true,
    })
    const verdict = classifyResultToGateVerdict({
      result: {
        verdict: 'allow',
        reason: 'read_only',
        fingerprint: 'fp',
        assessment: {
          reversibility: 'reversible',
          external: false,
          blastRadius: 'none',
          confidence: 1,
          signals: [],
        },
        effectPlan,
        wouldMediate: true,
        mediatedExecution: {
          exitCode: 0,
          signal: null,
          timedOut: false,
          stdout: 'done',
          stderr: '',
          stdoutTruncated: false,
          stderrTruncated: false,
          receiptHash: 'receipt',
        },
      },
      mode: 'audit',
      permission: 'allow',
      wouldBlock: false,
    })
    expect(verdict.wouldMediate).toBe(true)
    expect(verdict.mediatedExecution?.receiptHash).toBe('receipt')
  })

  it('keeps exact 16 KiB stdout and stderr output without truncation', async () => {
    const result = await runProcessWithBoundedOutput(
      process.execPath,
      ['-e', "process.stdout.write('o'.repeat(16384)); process.stderr.write('e'.repeat(16384))"],
      {},
      5_000,
    )
    expect(result.stdout).toBe('o'.repeat(16_384))
    expect(result.stderr).toBe('e'.repeat(16_384))
    expect(result.stdoutTruncated).toBe(false)
    expect(result.stderrTruncated).toBe(false)
  })

  it('retains the final 16 KiB of 16,385-byte stdout and stderr output', async () => {
    const result = await runProcessWithBoundedOutput(
      process.execPath,
      ['-e', "process.stdout.write('a'.repeat(16385)); process.stderr.write('b'.repeat(16385))"],
      {},
      5_000,
    )
    expect(result.stdout).toBe('a'.repeat(16_384))
    expect(result.stderr).toBe('b'.repeat(16_384))
    expect(result.stdoutTruncated).toBe(true)
    expect(result.stderrTruncated).toBe(true)
  })

  it('drops a partial leading UTF-8 character from a truncated output tail', async () => {
    const result = await runProcessWithBoundedOutput(
      process.execPath,
      ['-e', "process.stdout.write('€'.repeat(5462)); process.stderr.write('€'.repeat(5462))"],
      {},
      5_000,
    )
    expect(result.stdout).toBe('€'.repeat(5461))
    expect(result.stderr).toBe('€'.repeat(5461))
    expect(Buffer.byteLength(result.stdout, 'utf8')).toBeLessThanOrEqual(16_384)
    expect(Buffer.byteLength(result.stderr, 'utf8')).toBeLessThanOrEqual(16_384)
    expect(result.stdoutTruncated).toBe(true)
    expect(result.stderrTruncated).toBe(true)
  })
})
