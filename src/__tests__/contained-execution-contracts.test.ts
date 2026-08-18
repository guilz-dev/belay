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

  it('retains 16 KiB output tails and marks truncation', async () => {
    const result = await runProcessWithBoundedOutput(
      process.execPath,
      [
        '-e',
        "process.stdout.write('x'.repeat(17000) + 'stdout-tail'); process.stderr.write('y'.repeat(17000) + 'stderr-tail')",
      ],
      {},
      5_000,
    )
    expect(result.stdout).toHaveLength(16_384)
    expect(result.stderr).toHaveLength(16_384)
    expect(result.stdout.endsWith('stdout-tail')).toBe(true)
    expect(result.stderr.endsWith('stderr-tail')).toBe(true)
    expect(result.stdoutTruncated).toBe(true)
    expect(result.stderrTruncated).toBe(true)
  })
})
