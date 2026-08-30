import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

const tempDirs: string[] = []
const probeModuleUrl = new URL('../../scripts/native-seatbelt-boundary-probe.mjs', import.meta.url)

async function probeModule() {
  return await import(probeModuleUrl.href)
}

async function createTempDir() {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'belay-native-seatbelt-probe-test-'))
  tempDirs.push(directory)
  return directory
}

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  )
})

function defaultEvidence() {
  return {
    operationDenied: true,
    exitCode: 1,
    signal: null,
    timedOut: false,
    markerPresent: false,
    acceptedConnections: 0,
    targetUnchanged: true,
    settledAfterMs: 42,
  }
}

function reportFixture(overrides: Record<string, unknown> = {}) {
  const base = {
    version: 1,
    status: 'PENDING',
    host: {
      platform: 'darwin',
      supported: true,
      productVersion: '15.0',
      kernel: '24.0.0',
      arch: 'arm64',
    },
    substrate: {
      available: true,
      executable: '/usr/bin/sandbox-exec',
      sha256: 'a'.repeat(64),
    },
    runtimeClosure: [
      {
        path: '/opt/homebrew/bin/node',
        sha256: 'b'.repeat(64),
        source: 'otool',
      },
    ],
    profile: {
      literalReads: [{ path: '/usr/lib/dyld', operation: 'file-read-data' }],
      literalExecs: [{ path: '/usr/bin/sandbox-exec', operation: 'file-read*' }],
      forbiddenBroadGrants: [] as Array<{ role: string; operation: string }>,
      sourceSha256: 'c'.repeat(64),
    },
    cases: [
      'mirror-read-write',
      'source-read-write',
      'home-secret-read-write',
      'control-plane-read-write',
      'absolute-path-read-write',
      'loopback-tcp',
      'unix-socket',
      'descendant-inheritance',
      'timeout-process-group',
      'output-capture',
    ].map((name) => ({ name, passed: true, evidence: defaultEvidence() })),
    latency: { samples: 30, medianOverheadMs: 80, p95OverheadMs: 220 },
    cleanup: { confirmed: true },
    evidenceManifestSha256: 'd'.repeat(64),
  }

  const merged = { ...base, ...overrides }
  if (overrides.host && typeof overrides.host === 'object') {
    merged.host = { ...base.host, ...overrides.host }
  }
  if (overrides.substrate && typeof overrides.substrate === 'object') {
    merged.substrate = { ...base.substrate, ...overrides.substrate }
  }
  if (overrides.profile && typeof overrides.profile === 'object') {
    merged.profile = { ...base.profile, ...overrides.profile }
  }
  if (overrides.latency && typeof overrides.latency === 'object') {
    merged.latency = { ...base.latency, ...overrides.latency }
  }
  if (overrides.cleanup && typeof overrides.cleanup === 'object') {
    merged.cleanup = { ...base.cleanup, ...overrides.cleanup }
  }
  if (Array.isArray(overrides.cases)) {
    merged.cases = overrides.cases.map((entry) => ({
      ...defaultEvidence(),
      evidence: defaultEvidence(),
      ...(typeof entry === 'object' && entry !== null ? entry : {}),
    }))
  }
  return merged
}

describe('native Seatbelt boundary probe evidence contract', () => {
  it('exports the frozen REQUIRED_CASE_NAMES list', async () => {
    const { REQUIRED_CASE_NAMES } = await probeModule()
    expect(REQUIRED_CASE_NAMES).toEqual([
      'mirror-read-write',
      'source-read-write',
      'home-secret-read-write',
      'control-plane-read-write',
      'absolute-path-read-write',
      'loopback-tcp',
      'unix-socket',
      'descendant-inheritance',
      'timeout-process-group',
      'output-capture',
    ])
  })

  describe('parseCaseRecords', () => {
    it('parses valid newline-delimited JSON case records', async () => {
      const { parseCaseRecords } = await probeModule()
      const text = [
        JSON.stringify({ version: 1, name: 'loopback-tcp', passed: true }),
        JSON.stringify({ version: 1, name: 'unix-socket', passed: false }),
      ].join('\n')

      expect(parseCaseRecords(text)).toEqual([
        { version: 1, name: 'loopback-tcp', passed: true },
        { version: 1, name: 'unix-socket', passed: false },
      ])
    })

    it('rejects malformed JSON', async () => {
      const { parseCaseRecords } = await probeModule()
      expect(() => parseCaseRecords('{not json')).toThrow()
    })

    it('rejects unknown record versions', async () => {
      const { parseCaseRecords } = await probeModule()
      expect(() =>
        parseCaseRecords(JSON.stringify({ version: 2, name: 'loopback-tcp', passed: true })),
      ).toThrow('invalid or duplicate Seatbelt probe case record')
    })

    it('rejects duplicate case names', async () => {
      const { parseCaseRecords } = await probeModule()
      const text = [
        JSON.stringify({ version: 1, name: 'loopback-tcp', passed: true }),
        JSON.stringify({ version: 1, name: 'loopback-tcp', passed: false }),
      ].join('\n')
      expect(() => parseCaseRecords(text)).toThrow(
        'invalid or duplicate Seatbelt probe case record',
      )
    })

    it('rejects missing required scalar fields', async () => {
      const { parseCaseRecords } = await probeModule()
      expect(() =>
        parseCaseRecords(JSON.stringify({ version: 1, name: 'loopback-tcp' })),
      ).toThrow('invalid or duplicate Seatbelt probe case record')
    })
  })

  describe('percentile', () => {
    it('returns the ceiling-ranked sample for a fraction', async () => {
      const { percentile } = await probeModule()
      expect(percentile([10, 20, 30, 40, 50], 0.5)).toBe(30)
      expect(percentile([10, 20, 30, 40, 50], 0.95)).toBe(50)
    })

    it('rejects empty samples or invalid fractions', async () => {
      const { percentile } = await probeModule()
      expect(() => percentile([], 0.5)).toThrow(
        'percentile requires samples and a fraction in (0, 1]',
      )
      expect(() => percentile([1, 2, 3], 0)).toThrow(
        'percentile requires samples and a fraction in (0, 1]',
      )
      expect(() => percentile([1, 2, 3], 1.1)).toThrow(
        'percentile requires samples and a fraction in (0, 1]',
      )
    })
  })

  describe('decideProbe', () => {
    it('returns GO when all load-bearing rules pass', async () => {
      const { REQUIRED_CASE_NAMES, decideProbe } = await probeModule()
      const passing = reportFixture({
        cases: REQUIRED_CASE_NAMES.map((name) => ({ name, passed: true })),
        latency: { samples: 30, medianOverheadMs: 80, p95OverheadMs: 220 },
        cleanup: { confirmed: true },
        profile: { forbiddenBroadGrants: [] },
      })
      expect(decideProbe(passing)).toBe('GO')
    })

    it('returns NO-GO when a security case fails', async () => {
      const { decideProbe } = await probeModule()
      expect(
        decideProbe(reportFixture({ cases: [{ name: 'loopback-tcp', passed: false }] })),
      ).toBe('NO-GO')
    })

    it('returns NO-GO when forbidden broad grants are present', async () => {
      const { decideProbe } = await probeModule()
      expect(
        decideProbe(
          reportFixture({
            profile: {
              forbiddenBroadGrants: [{ role: 'opt-homebrew', operation: 'file-read*' }],
            },
          }),
        ),
      ).toBe('NO-GO')
    })

    it('returns NO-GO when median latency exceeds the budget', async () => {
      const { decideProbe } = await probeModule()
      expect(
        decideProbe(
          reportFixture({
            latency: { samples: 30, medianOverheadMs: 101, p95OverheadMs: 220 },
          }),
        ),
      ).toBe('NO-GO')
    })

    it('returns BLOCKED when the host is unsupported', async () => {
      const { decideProbe } = await probeModule()
      expect(decideProbe(reportFixture({ host: { supported: false } }))).toBe('BLOCKED')
    })

    it('returns BLOCKED when the substrate is unavailable', async () => {
      const { decideProbe } = await probeModule()
      expect(decideProbe(reportFixture({ substrate: { available: false } }))).toBe('BLOCKED')
    })
  })

  describe('redactProbeReport', () => {
    it('replaces absolute paths and strips sensitive values from serialized output', async () => {
      const { redactProbeReport } = await probeModule()
      const evidenceDir = await createTempDir()
      const fakeUsername = 'probe-user-secret'
      const envToken = 'sk_live_probe_token_abcdef123456'
      const secretSentinel = 'BELAY_SECRET_SENTINEL_XYZ'
      const runtimePath = `/Users/${fakeUsername}/.belay/runtime/node`
      const report = reportFixture({
        status: 'GO',
        substrate: {
          available: true,
          executable: '/usr/bin/sandbox-exec',
          sha256: 'a'.repeat(64),
        },
        runtimeClosure: [
          {
            path: runtimePath,
            sha256: 'b'.repeat(64),
            source: 'otool',
          },
          {
            path: evidenceDir,
            sha256: 'e'.repeat(64),
            source: 'fixture-root',
          },
          {
            path: path.join(evidenceDir, envToken),
            sha256: 'f'.repeat(64),
            source: 'closure',
          },
          {
            path: path.join(evidenceDir, secretSentinel),
            sha256: '0'.repeat(64),
            source: 'closure',
          },
        ],
        cases: [
          {
            name: 'home-secret-read-write',
            passed: true,
            evidence: {
              ...defaultEvidence(),
              operationDenied: true,
              markerPresent: false,
            },
          },
        ],
      })

      const redacted = redactProbeReport(report, evidenceDir)
      const serialized = JSON.stringify(redacted)

      expect(redacted.substrate.executableRole).toBe('<SANDBOX_EXEC>')
      expect(redacted.runtimeClosure[0].pathRole).toBe('<RUNTIME_FILE>')
      expect(redacted.runtimeClosure[1].pathRole).toBe('<PRIVATE_EVIDENCE_DIR>')
      expect(redacted.runtimeClosure[2].pathRole).toBe('<RUNTIME_FILE>')
      expect(redacted.runtimeClosure[3].pathRole).toBe('<RUNTIME_FILE>')
      expect(redacted.profile.literalReadCount).toBe(1)
      expect(redacted.profile.literalExecCount).toBe(1)
      expect(serialized).not.toContain(evidenceDir)
      expect(serialized).not.toContain(fakeUsername)
      expect(serialized).not.toContain(envToken)
      expect(serialized).not.toContain(secretSentinel)
      expect(serialized).not.toContain('/Users/')
      expect(serialized).not.toContain('/usr/bin/sandbox-exec')
    })
  })
})
