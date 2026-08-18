import { mkdtemp, readFile, rm } from 'node:fs/promises'
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
  imageReference: 'local/runner:task4',
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
  dockerConfiguration: {
    executable: '/usr/local/bin/docker',
    host: 'unix:///var/run/docker.sock',
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

const malformedNestedCapabilities: ReadonlyArray<readonly [string, Record<string, unknown>]> = [
  ['null Docker substrate', { dockerSubstrate: null }],
  ['primitive Docker substrate', { dockerSubstrate: 'x' }],
  ['array Docker substrate', { dockerSubstrate: [] }],
  [
    'wrong Docker substrate field type',
    { dockerSubstrate: { ...containedCapability.dockerSubstrate, binaryPath: 42 } },
  ],
  ['null Docker configuration', { dockerConfiguration: null }],
  ['primitive Docker configuration', { dockerConfiguration: 'x' }],
  ['array Docker configuration', { dockerConfiguration: [] }],
  [
    'wrong Docker configuration field type',
    { dockerConfiguration: { ...containedCapability.dockerConfiguration, host: 42 } },
  ],
  ['primitive tmpfs', { tmpfs: 'x' }],
  ['array tmpfs', { tmpfs: [] }],
  ['primitive resource limits', { resourceLimits: 'x' }],
  ['array resource limits', { resourceLimits: [] }],
]

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

  it.each(
    malformedNestedCapabilities,
  )('returns false without throwing for %s', (_name, override) => {
    const malformed: unknown = { ...containedCapability, ...override }
    expect(() => validateContainedExecutionAttestation(malformed)).not.toThrow()
    expect(validateContainedExecutionAttestation(malformed)).toBe(false)
  })

  it('rejects validly signed envelopes with malformed nested capabilities', async () => {
    controlPlaneDir = await mkdtemp(path.join(os.tmpdir(), 'belay-contained-attest-'))
    for (const [, override] of malformedNestedCapabilities) {
      const malformed = {
        ...attestation(),
        containedExecution: { ...containedCapability, ...override },
      } as unknown as BoundaryAttestation
      const signed = await signBoundaryAttestation({
        repoRoot: '/repo',
        attestation: malformed,
        controlPlaneDir,
      })
      await expect(
        verifySignedBoundaryAttestation({
          file: signed,
          expectedRepoRoot: '/repo',
          controlPlaneDir,
        }),
      ).resolves.toBeNull()
    }
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
          workspaceChangesDiscarded: true,
        },
      },
      mode: 'audit',
      permission: 'allow',
      wouldBlock: false,
    })
    expect(verdict.wouldMediate).toBe(true)
    expect(verdict.mediatedExecution?.receiptHash).toBe('receipt')
  })

  it('publishes the contained-execution contract without turning it into shell authority', async () => {
    const repositoryRoot = path.resolve(import.meta.dirname, '../..')
    const documents = await Promise.all(
      [
        'docs/adr/ADR-006-contained-unknown-execution.md',
        'docs/CONTEXT.md',
        'docs/execution-boundary-map.ja.md',
        'docs/guarantee-table.md',
        'docs/config-schema.md',
        'README.md',
        'CHANGELOG.md',
      ].map((file) => readFile(path.join(repositoryRoot, file), 'utf8')),
    )
    const [adr, context, boundaryMap, guarantees, configSchema, readme, changelog] = documents

    expect(adr).toContain('EffectPlan remains the sole shell authority')
    expect(adr).toContain('does not grant eligibility')
    expect(adr).toMatch(/command\s+allowlists remain\s+prohibited/)
    expect(context).toContain('contained execution capability')
    expect(context).toContain('does not imply `materializesGrants`')
    expect(boundaryMap).toContain('contained unknown execution')
    expect(boundaryMap).toContain('copy-only')
    expect(boundaryMap).toContain('Audit mode reports `wouldMediate: true` and executes nothing')
    expect(guarantees).toContain('Contained unknown execution (opt-in)')
    expect(guarantees).toContain('not an L1-full claim')
    expect(guarantees).toMatch(/log driver is `none`/)
    expect(configSchema).toContain('`sandbox.containedExecution`')
    expect(configSchema).toContain('no automatic image build or pull')
    expect(configSchema).toContain('local Unix socket')
    expect(readme).toContain('Contained unknown execution (opt-in)')
    expect(readme).toContain('No command allowlist is involved')
    expect(readme).toMatch(/workspace changes are\s+discarded/i)
    expect(changelog).toContain('Contained unknown execution')
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

  it.each([
    [
      'authorization whitespace',
      `Authorization:${' '.repeat(40_000)}AUTH.LEAK.VALUE. END 終端`,
      ['AUTH.LEAK.VALUE.'],
    ],
    [
      'quoted authorization whitespace',
      `"Authorization:${' '.repeat(40_000)}QUOTED.AUTH.LEAK." END 終端`,
      ['QUOTED.AUTH.LEAK.'],
    ],
    [
      'bearer whitespace',
      `Bearer${' '.repeat(40_000)}BEAR.LEAK.VALUE. END 終端`,
      ['BEAR.LEAK.VALUE.'],
    ],
    [
      'generic-header whitespace',
      `X-Api-Key:${' '.repeat(40_000)}HEADER.LEAK.VALUE. END 終端`,
      ['HEADER.LEAK.VALUE.'],
    ],
    [
      'quoted generic-header whitespace',
      `'Private-Token:${' '.repeat(40_000)}QUOTED.HEADER.LEAK.' END 終端`,
      ['QUOTED.HEADER.LEAK.'],
    ],
    [
      'key/value whitespace',
      `token=${' '.repeat(40_000)}TOKEN.LEAK.VALUE. END 終端`,
      ['TOKEN.LEAK.VALUE.'],
    ],
    [
      'approval whitespace',
      `/belay-approve${' '.repeat(40_000)}APPROVAL.LEAK.VALUE. END 終端`,
      ['APPROVAL.LEAK.VALUE.'],
    ],
    [
      'long URL username',
      `https://${'user.part.'.repeat(3_000)}:PASS.LEAK.VALUE.@host/path END 終端`,
      ['user.part.', 'PASS.LEAK.VALUE.'],
    ],
    ['mysql inline password', 'mysql -pMYSQL.LEAK.VALUE. database END 終端', ['MYSQL.LEAK.VALUE.']],
    [
      'approval ID',
      'belay_approvalleakvalue123456789 END 終端',
      ['belay_approvalleakvalue123456789'],
    ],
    [
      'high entropy value',
      `${'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789abcdef'.repeat(2)} END 終端`,
      ['ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789abcdef'],
    ],
    [
      'UUID',
      '123e4567-e89b-42d3-a456-426614174000 END 終端',
      ['123e4567-e89b-42d3-a456-426614174000'],
    ],
    ['timestamp', '2026-08-18T12:34:56.789Z END 終端', ['2026-08-18T12:34:56.789Z']],
  ] as const)('scrubs real child stdout and stderr with an undecided %s prefix before tailing', async (_name, output, forbidden) => {
    const result = await runProcessWithBoundedOutput(
      process.execPath,
      [
        '-e',
        `const value = Buffer.from(process.argv[1]); const sizes = [1, 7, 2, 31, 3, 64, 11, 127, 4, 19]; let offset = 0; let index = 0; while (offset < value.length) { const end = Math.min(offset + sizes[index % sizes.length], value.length); const chunk = value.subarray(offset, end); process.stdout.write(chunk); process.stderr.write(chunk); offset = end; index += 1 }`,
        output,
      ],
      {},
      5_000,
      {
        scrubOptions: {
          maskApprovalIds: true,
          maskBearerTokens: true,
          maskAuthHeaders: true,
          maskKeyValueSecrets: true,
          maskHighEntropyStrings: true,
        },
      },
    )
    const expectedTruncated = Buffer.byteLength(output) > 16_384
    expect(result.stdoutTruncated).toBe(expectedTruncated)
    expect(result.stderrTruncated).toBe(expectedTruncated)
    for (const captured of [result.stdout, result.stderr]) {
      expect(Buffer.byteLength(captured)).toBeLessThanOrEqual(16_384)
      expect(Buffer.from(captured).toString('utf8')).toBe(captured)
      expect(captured).not.toContain('\uFFFD')
      expect(captured).toContain('END 終端')
      for (const secret of forbidden) expect(captured).not.toContain(secret)
    }
  })

  it.each(
    ['"', "'"].flatMap((quote) => {
      const quoteName = quote === '"' ? 'double-quoted' : 'single-quoted'
      return [
        [`${quoteName} authorization`, `Authorization: abc${quote}`, 'AUTH.QUOTE.LEAK.'],
        [`${quoteName} generic header`, `X-Api-Key: abc${quote}`, 'HEADER.QUOTE.LEAK.'],
        [`${quoteName} approval command`, `/belay-approve abc${quote}`, 'APPROVAL.QUOTE.LEAK.'],
        [`${quoteName} mysql password`, `mysql -pabc${quote}`, 'MYSQL.QUOTE.LEAK.'],
      ]
    }),
  )('keeps an embedded quote inside real-child %s values until whitespace', async (_name, prefix, sentinel) => {
    const output = `${prefix}${sentinel.repeat(2_000)} END 終端`
    const result = await runProcessWithBoundedOutput(
      process.execPath,
      [
        '-e',
        `const value = Buffer.from(process.argv[1]); const sizes = [1, 7, 2, 31, 3, 64, 11, 127, 4, 19]; let offset = 0; let index = 0; while (offset < value.length) { const end = Math.min(offset + sizes[index % sizes.length], value.length); const chunk = value.subarray(offset, end); process.stdout.write(chunk); process.stderr.write(chunk); offset = end; index += 1 }`,
        output,
      ],
      {},
      5_000,
      {
        scrubOptions: {
          maskApprovalIds: true,
          maskBearerTokens: true,
          maskAuthHeaders: true,
          maskKeyValueSecrets: true,
          maskHighEntropyStrings: true,
        },
      },
    )
    expect(result.stdoutTruncated).toBe(true)
    expect(result.stderrTruncated).toBe(true)
    for (const captured of [result.stdout, result.stderr]) {
      expect(Buffer.byteLength(captured)).toBeLessThanOrEqual(16_384)
      expect(captured).not.toContain('\uFFFD')
      expect(captured).not.toContain(sentinel)
      expect(captured).toContain('END 終端')
    }
  })

  it.each([
    [
      'question mark in username',
      `https://pre?${'URL.USER.QUESTION.LEAK.'.repeat(2_000)}:pass@host/path END 終端`,
      'URL.USER.QUESTION.LEAK.',
    ],
    [
      'hash in username',
      `https://pre#${'URL.USER.HASH.LEAK.'.repeat(2_000)}:pass@host/path END 終端`,
      'URL.USER.HASH.LEAK.',
    ],
    [
      'question mark in password',
      `https://user:pre?${'URL.PASSWORD.QUESTION.LEAK.'.repeat(2_000)}@host/path END 終端`,
      'URL.PASSWORD.QUESTION.LEAK.',
    ],
    [
      'hash in password',
      `https://user:pre#${'URL.PASSWORD.HASH.LEAK.'.repeat(2_000)}@host/path END 終端`,
      'URL.PASSWORD.HASH.LEAK.',
    ],
  ] as const)('keeps real-child URL %s inside the authority state on stdout and stderr', async (_name, output, sentinel) => {
    const result = await runProcessWithBoundedOutput(
      process.execPath,
      [
        '-e',
        `const value = Buffer.from(process.argv[1]); const sizes = [1, 7, 2, 31, 3, 64, 11, 127, 4, 19]; let offset = 0; let index = 0; while (offset < value.length) { const end = Math.min(offset + sizes[index % sizes.length], value.length); const chunk = value.subarray(offset, end); process.stdout.write(chunk); process.stderr.write(chunk); offset = end; index += 1 }`,
        output,
      ],
      {},
      5_000,
      {
        scrubOptions: {
          maskApprovalIds: true,
          maskBearerTokens: true,
          maskAuthHeaders: true,
          maskKeyValueSecrets: true,
          maskHighEntropyStrings: true,
        },
      },
    )
    expect(result.stdoutTruncated).toBe(true)
    expect(result.stderrTruncated).toBe(true)
    for (const captured of [result.stdout, result.stderr]) {
      expect(Buffer.byteLength(captured)).toBeLessThanOrEqual(16_384)
      expect(captured).not.toContain('\uFFFD')
      expect(captured).not.toContain(sentinel)
      expect(captured).toContain('END 終端')
    }
  })
})
