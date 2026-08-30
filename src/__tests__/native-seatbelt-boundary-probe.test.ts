import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
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
    runtimeSkippedDependencies: [],
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
    timing: { mirrorPreparationMs: 12, caseCommandMs: 34, benchmarkCommandMs: 56 },
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
      expect(() => parseCaseRecords(JSON.stringify({ version: 1, name: 'loopback-tcp' }))).toThrow(
        'invalid or duplicate Seatbelt probe case record',
      )
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
        cases: REQUIRED_CASE_NAMES.map((name: string) => ({ name, passed: true })),
        latency: { samples: 30, medianOverheadMs: 80, p95OverheadMs: 220 },
        cleanup: { confirmed: true },
        profile: { forbiddenBroadGrants: [] },
      })
      expect(decideProbe(passing)).toBe('GO')
    })

    it('returns NO-GO when a security case fails', async () => {
      const { decideProbe } = await probeModule()
      expect(decideProbe(reportFixture({ cases: [{ name: 'loopback-tcp', passed: false }] }))).toBe(
        'NO-GO',
      )
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

    it('returns NO-GO when any runtime dependency was skipped', async () => {
      const { decideProbe } = await probeModule()
      expect(
        decideProbe(
          reportFixture({
            runtimeSkippedDependencies: [
              {
                path: '/System/Library/Frameworks/CoreFoundation.framework',
                reason: 'unreachable',
              },
            ],
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

    it('returns NO-GO when p95 latency exceeds the budget', async () => {
      const { decideProbe } = await probeModule()
      expect(
        decideProbe(
          reportFixture({
            latency: { samples: 30, medianOverheadMs: 80, p95OverheadMs: 251 },
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

    it('returns NO-GO when cleanup is not confirmed', async () => {
      const { decideProbe } = await probeModule()
      expect(decideProbe(reportFixture({ cleanup: { confirmed: false } }))).toBe('NO-GO')
    })

    it('never returns GO when the host is unsupported even if other gates pass', async () => {
      const { REQUIRED_CASE_NAMES, decideProbe } = await probeModule()
      const unsupportedButOtherwisePassing = reportFixture({
        host: {
          supported: false,
          platform: 'linux',
          productVersion: null,
          kernel: null,
          arch: 'x64',
        },
        cases: REQUIRED_CASE_NAMES.map((name: string) => ({ name, passed: true })),
        latency: { samples: 30, medianOverheadMs: 50, p95OverheadMs: 100 },
        cleanup: { confirmed: true },
        profile: { forbiddenBroadGrants: [] },
      })
      expect(decideProbe(unsupportedButOtherwisePassing)).not.toBe('GO')
      expect(decideProbe(unsupportedButOtherwisePassing)).toBe('BLOCKED')
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

  describe('parseOtoolLibraries', () => {
    it('extracts library references from otool -L stdout', async () => {
      const { parseOtoolLibraries } = await probeModule()
      const stdout = [
        '/opt/homebrew/bin/node:',
        '\t/usr/lib/libSystem.B.dylib (compatibility version 1.0.0, current version 1351.0.0)',
        '\t@loader_path/../lib/libuv.1.dylib (compatibility version 1.0.0, current version 1.0.0)',
        '\t/opt/homebrew/opt/libuv/lib/libuv.1.dylib (compatibility version 1.0.0, current version 1.0.0)',
      ].join('\n')

      expect(parseOtoolLibraries(stdout)).toEqual([
        '/usr/lib/libSystem.B.dylib',
        '@loader_path/../lib/libuv.1.dylib',
        '/opt/homebrew/opt/libuv/lib/libuv.1.dylib',
      ])
    })

    it('returns an empty list when no dependency lines are present', async () => {
      const { parseOtoolLibraries } = await probeModule()
      expect(parseOtoolLibraries('/opt/homebrew/bin/node:\n')).toEqual([])
    })
  })

  describe('resolveLibraryReference', () => {
    it('resolves @loader_path and @executable_path references', async () => {
      const { resolveLibraryReference } = await probeModule()
      const loaderPath = '/opt/homebrew/Cellar/node/22.0.0/bin/node'
      const executablePath = '/private/var/tmp/belay-native-seatbelt-probe/mirror/node'

      expect(
        resolveLibraryReference('@loader_path/../lib/libuv.1.dylib', loaderPath, executablePath),
      ).toBe('/opt/homebrew/Cellar/node/22.0.0/lib/libuv.1.dylib')
      expect(
        resolveLibraryReference(
          '@executable_path/../deps/libfoo.dylib',
          loaderPath,
          executablePath,
        ),
      ).toBe('/private/var/tmp/belay-native-seatbelt-probe/deps/libfoo.dylib')
    })

    it('accepts absolute library paths unchanged', async () => {
      const { resolveLibraryReference } = await probeModule()
      expect(
        resolveLibraryReference(
          '/usr/lib/libSystem.B.dylib',
          '/opt/homebrew/bin/node',
          '/opt/homebrew/bin/node',
        ),
      ).toBe('/usr/lib/libSystem.B.dylib')
    })

    it('rejects @rpath, non-absolute resolutions, and unsafe path characters', async () => {
      const { resolveLibraryReference } = await probeModule()
      expect(() =>
        resolveLibraryReference(
          '@rpath/libnode.dylib',
          '/opt/homebrew/bin/node',
          '/opt/homebrew/bin/node',
        ),
      ).toThrow('unresolved @rpath library reference')
      expect(() =>
        resolveLibraryReference(
          'librelative.dylib',
          '/opt/homebrew/bin/node',
          '/opt/homebrew/bin/node',
        ),
      ).toThrow('library reference did not resolve to an absolute path')
      expect(() =>
        resolveLibraryReference(
          '/usr/lib/bad\u0000name.dylib',
          '/opt/homebrew/bin/node',
          '/opt/homebrew/bin/node',
        ),
      ).toThrow('seatbelt path contains forbidden characters')
    })
  })

  describe('resolveRuntimeClosure', () => {
    it('derives a canonical closure with injected deps', async () => {
      const { resolveRuntimeClosure } = await probeModule()
      const canonicalNodePath = '/opt/homebrew/bin/node'
      const canonicalLibPath = '/opt/homebrew/opt/libuv/lib/libuv.1.dylib'
      const symlinkNodePath = '/tmp/probe-node-link'
      const otoolOutput = [
        `${canonicalNodePath}:`,
        `\t${canonicalLibPath} (compatibility version 1.0.0, current version 1.0.0)`,
      ].join('\n')
      const libOtoolOutput = `${canonicalLibPath}:\n`

      const { closure, skippedDependencies } = await resolveRuntimeClosure(symlinkNodePath, {
        realpath: async (value: string) => (value === symlinkNodePath ? canonicalNodePath : value),
        stat: async () => ({ isFile: () => true }),
        sha256File: async (value: string) =>
          value === canonicalNodePath ? 'node-hash' : 'libuv-hash',
        runOtool: async (value: string) => ({
          stdout: value === canonicalNodePath ? otoolOutput : libOtoolOutput,
        }),
      })

      expect(skippedDependencies).toEqual([])
      expect(closure).toEqual([
        {
          path: canonicalNodePath,
          sha256: 'node-hash',
          source: 'executable',
        },
        {
          path: canonicalLibPath,
          sha256: 'libuv-hash',
          source: 'dependency',
        },
      ])
    })

    it('deduplicates dependencies and tolerates closure cycles', async () => {
      const { resolveRuntimeClosure } = await probeModule()
      const left = '/tmp/probe-left.dylib'
      const right = '/tmp/probe-right.dylib'
      const calls = new Map([
        [
          left,
          {
            stdout: `${left}:\n\t${right} (compatibility version 1.0.0, current version 1.0.0)\n`,
          },
        ],
        [
          right,
          {
            stdout: `${right}:\n\t${left} (compatibility version 1.0.0, current version 1.0.0)\n`,
          },
        ],
      ])

      const { closure } = await resolveRuntimeClosure(left, {
        realpath: async (value: string) => value,
        stat: async () => ({ isFile: () => true }),
        sha256File: async (value: string) => `${value}-hash`,
        runOtool: async (value: string) => calls.get(value),
      })

      expect(closure).toEqual([
        { path: left, sha256: `${left}-hash`, source: 'executable' },
        { path: right, sha256: `${right}-hash`, source: 'dependency' },
      ])
    })

    it('supports spaces and quotes in resolved library paths', async () => {
      const { resolveRuntimeClosure } = await probeModule()
      const executablePath = '/tmp/probe exec/node'
      const quotedLibPath = '/tmp/probe exec/lib "special".dylib'
      const otoolOutput = [
        `${executablePath}:`,
        `\t@loader_path/lib "special".dylib (compatibility version 1.0.0, current version 1.0.0)`,
      ].join('\n')

      const { closure } = await resolveRuntimeClosure(executablePath, {
        realpath: async (value: string) => value,
        stat: async () => ({ isFile: () => true }),
        sha256File: async (value: string) => `${value}-hash`,
        runOtool: async (value: string) => ({
          stdout: value === executablePath ? otoolOutput : `${quotedLibPath}:\n`,
        }),
      })

      expect(closure).toEqual([
        { path: quotedLibPath, sha256: `${quotedLibPath}-hash`, source: 'dependency' },
        { path: executablePath, sha256: `${executablePath}-hash`, source: 'executable' },
      ])
    })

    it('rejects non-regular files in the closure', async () => {
      const { resolveRuntimeClosure } = await probeModule()
      await expect(
        resolveRuntimeClosure('/tmp/probe-directory', {
          realpath: async (value: string) => value,
          stat: async () => ({ isFile: () => false }),
          sha256File: async () => 'unused',
          runOtool: async () => ({ stdout: '' }),
        }),
      ).rejects.toThrow('runtime closure is not a file')
    })

    it('skips dependency paths that are not reachable on the host', async () => {
      const { resolveRuntimeClosure } = await probeModule()
      const executablePath = '/opt/homebrew/bin/node'
      const reachableLib = '/usr/lib/libSystem.B.dylib'
      const missingFramework =
        '/System/Library/Frameworks/CoreFoundation.framework/Versions/A/CoreFoundation'
      const otoolOutput = [
        `${executablePath}:`,
        `\t${missingFramework} (compatibility version 150.0.0, current version 1.0.0)`,
        `\t${reachableLib} (compatibility version 1.0.0, current version 1.0.0)`,
      ].join('\n')

      const { closure, skippedDependencies } = await resolveRuntimeClosure(executablePath, {
        realpath: async (value: string) => {
          if (value === missingFramework) {
            throw new Error('ENOENT')
          }
          return value
        },
        stat: async (value: string) => ({
          isFile: () => value === executablePath || value === reachableLib,
        }),
        sha256File: async (value: string) => `${value}-hash`,
        runOtool: async (value: string) => ({
          stdout: value === executablePath ? otoolOutput : `${reachableLib}:\n`,
        }),
      })

      expect(skippedDependencies).toEqual([{ path: missingFramework, reason: 'unreachable' }])
      expect(closure).toEqual([
        { path: executablePath, sha256: `${executablePath}-hash`, source: 'executable' },
        { path: reachableLib, sha256: `${reachableLib}-hash`, source: 'dependency' },
      ])
    })
  })

  describe('seatbeltQuote', () => {
    it('escapes backslashes and double quotes for Seatbelt literals', async () => {
      const { seatbeltQuote } = await probeModule()
      expect(seatbeltQuote('/tmp/probe\\path "quoted"')).toBe('"/tmp/probe\\\\path \\"quoted\\""')
    })

    it('rejects NUL and newline characters', async () => {
      const { seatbeltQuote } = await probeModule()
      expect(() => seatbeltQuote('/tmp/bad\u0000path')).toThrow(
        'seatbelt path contains forbidden characters',
      )
      expect(() => seatbeltQuote('/tmp/bad\npath')).toThrow(
        'seatbelt path contains forbidden characters',
      )
    })
  })

  describe('compileSeatbeltProfile', () => {
    const systemLiterals = [
      { path: '/dev/null', operation: 'file-read-data' },
      { path: '/usr/lib/dyld', operation: 'file-read-data' },
    ]

    it('inventories every non-literal baseline grant as broad evidence', async () => {
      const { compileSeatbeltProfile, seatbeltQuote } = await probeModule()
      const mirrorRoot = '/private/var/tmp/belay-native-seatbelt-probe/mirror'
      const evidenceDir = '/private/var/tmp/belay-native-seatbelt-probe/evidence'
      const homeDir = '/Users/probe-user'
      const canonicalNodePath = '/opt/homebrew/bin/node'
      const canonicalLibPath = '/opt/homebrew/opt/libuv/lib/libuv.1.dylib'

      const profile = compileSeatbeltProfile({
        mirrorRoot,
        evidenceDir,
        homeDir,
        systemLiterals,
        runtimeClosure: [
          {
            path: canonicalNodePath,
            sha256: 'node-hash',
            source: 'executable',
          },
          {
            path: canonicalLibPath,
            sha256: 'libuv-hash',
            source: 'dependency',
          },
        ],
      })

      expect(profile.source).toContain('(version 1)')
      expect(profile.source).toContain('(deny default)')
      expect(profile.source).toContain('(import "dyld-support.sb")')
      expect(profile.source).toContain('(allow process-fork)')
      expect(profile.source).toContain(`(allow file-read* (subpath ${seatbeltQuote(mirrorRoot)}))`)
      expect(profile.source).toContain(`(allow file-write* (subpath ${seatbeltQuote(mirrorRoot)}))`)
      expect(profile.source).toContain(`(allow file-read* (subpath ${seatbeltQuote(evidenceDir)}))`)
      expect(profile.source).toContain(
        `(allow file-write* (subpath ${seatbeltQuote(evidenceDir)}))`,
      )
      expect(profile.source).toContain(
        `(allow file-read-data (literal ${seatbeltQuote('/dev/null')}))`,
      )
      expect(profile.source).toContain(
        `(allow file-read-data (literal ${seatbeltQuote('/usr/lib/dyld')}))`,
      )
      expect(profile.source).not.toContain('(allow network*')
      expect(profile.source).not.toContain(`(subpath ${seatbeltQuote(homeDir)})`)
      expect(profile.literalExecs).toEqual([canonicalNodePath])
      expect(profile.literalReads).toEqual(
        expect.arrayContaining([
          { path: canonicalLibPath, operation: 'file-read-data' },
          { path: '/dev/null', operation: 'file-read-data' },
          { path: '/usr/lib/dyld', operation: 'file-read-data' },
        ]),
      )
      expect(profile.mirrorRoot).toBe(mirrorRoot)
      expect(profile.forbiddenBroadGrants).toEqual([
        {
          role: 'baseline-import:dyld-support.sb',
          operation: 'import',
          source: 'dyld-support.sb',
        },
        { role: 'global-mach-lookup', operation: 'mach-lookup' },
        { role: 'global-sysctl-read', operation: 'sysctl-read' },
        { role: 'global-file-read-metadata', operation: 'file-read-metadata' },
        {
          role: 'system-openssl',
          operation: 'file-read*',
          subpath: '/System/Library/OpenSSL',
        },
      ])
    })

    it('allows exact literals under /usr/local and /opt/homebrew but rejects broad subpaths', async () => {
      const { compileSeatbeltProfile, seatbeltQuote } = await probeModule()
      const homebrewLiteral = '/opt/homebrew/bin/node'
      const usrLocalLiteral = '/usr/local/lib/libprobe.dylib'

      const exactLiteralProfile = compileSeatbeltProfile({
        mirrorRoot: '/private/var/tmp/belay-native-seatbelt-probe/mirror',
        evidenceDir: '/private/var/tmp/belay-native-seatbelt-probe/evidence',
        homeDir: '/Users/probe-user',
        systemLiterals: [],
        runtimeClosure: [
          { path: homebrewLiteral, sha256: 'node-hash', source: 'executable' },
          { path: usrLocalLiteral, sha256: 'usr-local-hash', source: 'dependency' },
        ],
        systemSubpathGrants: [],
        baselineImports: [],
        globalGrants: [],
      })

      expect(exactLiteralProfile.source).toContain(
        `(allow process-exec (literal ${seatbeltQuote(homebrewLiteral)}))`,
      )
      expect(exactLiteralProfile.source).toContain(
        `(allow file-read-data (literal ${seatbeltQuote(usrLocalLiteral)}))`,
      )
      expect(exactLiteralProfile.forbiddenBroadGrants).toEqual([])

      for (const subpath of ['/', '/Users/probe-user', '/usr/local', '/opt/homebrew']) {
        const profile = compileSeatbeltProfile({
          mirrorRoot: '/private/var/tmp/belay-native-seatbelt-probe/mirror',
          evidenceDir: '/private/var/tmp/belay-native-seatbelt-probe/evidence',
          homeDir: '/Users/probe-user',
          systemLiterals: [],
          systemSubpathGrants: [],
          baselineImports: [],
          globalGrants: [],
          runtimeClosure: [{ path: homebrewLiteral, sha256: 'node-hash', source: 'executable' }],
          requestedSubpathGrants: [{ subpath, operation: 'file-read*' }],
        })

        expect(profile.forbiddenBroadGrants).toEqual([
          {
            role:
              subpath === '/'
                ? 'root'
                : subpath === '/Users/probe-user'
                  ? 'home'
                  : subpath === '/usr/local'
                    ? 'usr-local'
                    : 'opt-homebrew',
            operation: 'file-read*',
            subpath,
          },
        ])
        expect(profile.source).not.toContain(`(subpath ${seatbeltQuote(subpath)})`)
      }
    })
  })

  describe('validateProfileGrantInventory', () => {
    it('returns GO when every required resource is present in the profile inventory', async () => {
      const { compileSeatbeltProfile, validateProfileGrantInventory } = await probeModule()
      const profile = compileSeatbeltProfile({
        mirrorRoot: '/private/var/tmp/belay-native-seatbelt-probe/mirror',
        evidenceDir: '/private/var/tmp/belay-native-seatbelt-probe/evidence',
        homeDir: '/Users/probe-user',
        systemLiterals: [{ path: '/usr/lib/dyld', operation: 'file-read-data' }],
        runtimeClosure: [
          {
            path: '/opt/homebrew/bin/node',
            sha256: 'node-hash',
            source: 'executable',
          },
        ],
      })

      expect(
        validateProfileGrantInventory(profile, {
          requiredReads: ['/usr/lib/dyld'],
          requiredExecs: ['/opt/homebrew/bin/node'],
          requiredMirrorRoot: '/private/var/tmp/belay-native-seatbelt-probe/mirror',
          requiredEvidenceDir: '/private/var/tmp/belay-native-seatbelt-probe/evidence',
        }),
      ).toEqual({ status: 'GO' })
    })

    it('returns NO-GO evidence when a required resource is absent', async () => {
      const { compileSeatbeltProfile, validateProfileGrantInventory } = await probeModule()
      const profile = compileSeatbeltProfile({
        mirrorRoot: '/private/var/tmp/belay-native-seatbelt-probe/mirror',
        evidenceDir: '/private/var/tmp/belay-native-seatbelt-probe/evidence',
        homeDir: '/Users/probe-user',
        systemLiterals: [],
        runtimeClosure: [
          {
            path: '/opt/homebrew/bin/node',
            sha256: 'node-hash',
            source: 'executable',
          },
        ],
      })

      expect(
        validateProfileGrantInventory(profile, {
          requiredReads: ['/usr/lib/dyld'],
          requiredExecs: ['/opt/homebrew/bin/node'],
          requiredMirrorRoot: '/private/var/tmp/belay-native-seatbelt-probe/mirror',
          requiredEvidenceDir: '/private/var/tmp/belay-native-seatbelt-probe/evidence',
        }),
      ).toEqual({
        status: 'NO-GO',
        missing: [{ kind: 'read', path: '/usr/lib/dyld' }],
      })
    })
  })

  describe('mirrorFixtureManifest', () => {
    it('omits sentinel values from the mirror-visible manifest', async () => {
      const { mirrorFixtureManifest } = await probeModule()
      const manifest = mirrorFixtureManifest({
        nonce: 'nonce',
        root: '/private/var/tmp/probe',
        mirrorDir: '/private/var/tmp/probe/mirror',
        forbiddenSourceDir: '/private/var/tmp/probe/forbidden-source',
        fakeHomeDir: '/private/var/tmp/probe/fake-home',
        controlPlaneDir: '/private/var/tmp/probe/control-plane',
        listenersDir: '/private/var/tmp/probe/listeners',
        evidenceDir: '/private/var/tmp/probe/evidence',
        mirrorScriptPath: '/private/var/tmp/probe/mirror/script.mjs',
        absoluteForbiddenPath: '/private/var/tmp/probe/absolute-forbidden/target',
        tcpPort: 12345,
        unixSocketPath: '/private/var/tmp/probe/listeners/probe.sock',
        postCleanupMarkerPath: '/private/var/tmp/probe/evidence/post-cleanup-marker',
        sentinels: { homeSecret: 'super-secret-value' },
      })

      expect(JSON.stringify(manifest)).not.toContain('super-secret-value')
      expect(manifest).not.toHaveProperty('sentinels')
    })
  })

  describe('evaluateSandboxedCase', () => {
    it('requires both read and write denial for forbidden cases', async () => {
      const { evaluateSandboxedCase } = await probeModule()
      const fixture = {
        forbiddenSourceDir: '/private/var/tmp/probe/forbidden-source',
        fakeHomeDir: '/private/var/tmp/probe/fake-home',
        controlPlaneDir: '/private/var/tmp/probe/control-plane',
        absoluteForbiddenPath: '/private/var/tmp/probe/absolute-forbidden/target',
        evidenceDir: '/private/var/tmp/probe/evidence',
        sentinels: {
          forbiddenSource: 'source-secret',
          homeSecret: 'home-secret',
          controlPlane: 'control-secret',
          absoluteForbidden: 'absolute-secret',
        },
      }
      const target = path.join(fixture.forbiddenSourceDir, 'source-sentinel.txt')
      const evaluated = await evaluateSandboxedCase(
        fixture,
        'source-read-write',
        { exitCode: 1, signal: null, timedOut: false, stdout: '', stderr: '', settledAfterMs: 1 },
        {
          preHashes: { [target]: 'before-hash' },
          sha256File: async () => 'before-hash',
          readFile: async () =>
            `${JSON.stringify({
              version: 1,
              name: 'source-read-write',
              readDenied: true,
              writeDenied: false,
              readLeaked: false,
              passed: false,
            })}\n`,
        },
      )

      expect(evaluated.passed).toBe(false)
    })

    it('uses pre-case hashes to detect target mutation', async () => {
      const { evaluateSandboxedCase } = await probeModule()
      const fixture = {
        forbiddenSourceDir: '/private/var/tmp/probe/forbidden-source',
        fakeHomeDir: '/private/var/tmp/probe/fake-home',
        controlPlaneDir: '/private/var/tmp/probe/control-plane',
        absoluteForbiddenPath: '/private/var/tmp/probe/absolute-forbidden/target',
        evidenceDir: '/private/var/tmp/probe/evidence',
        sentinels: {
          forbiddenSource: 'source-secret',
          homeSecret: 'home-secret',
          controlPlane: 'control-secret',
          absoluteForbidden: 'absolute-secret',
        },
      }
      const target = path.join(fixture.forbiddenSourceDir, 'source-sentinel.txt')
      const evaluated = await evaluateSandboxedCase(
        fixture,
        'source-read-write',
        { exitCode: 1, signal: null, timedOut: false, stdout: '', stderr: '', settledAfterMs: 1 },
        {
          preHashes: { [target]: 'before-hash' },
          sha256File: async () => 'after-hash',
          readFile: async () =>
            `${JSON.stringify({
              version: 1,
              name: 'source-read-write',
              readDenied: true,
              writeDenied: true,
              readLeaked: false,
              passed: true,
            })}\n`,
        },
      )

      expect(evaluated.passed).toBe(false)
      expect(evaluated.evidence.targetUnchanged).toBe(false)
    })

    it('detects creation of the forbidden write target independently of the read sentinel', async () => {
      const { evaluateSandboxedCase } = await probeModule()
      const fixture = {
        forbiddenSourceDir: '/private/var/tmp/probe/forbidden-source',
        fakeHomeDir: '/private/var/tmp/probe/fake-home',
        controlPlaneDir: '/private/var/tmp/probe/control-plane',
        absoluteForbiddenPath: '/private/var/tmp/probe/absolute-forbidden/target',
        evidenceDir: '/private/var/tmp/probe/evidence',
        sentinels: {
          forbiddenSource: 'source-secret',
          homeSecret: 'home-secret',
          controlPlane: 'control-secret',
          absoluteForbidden: 'absolute-secret',
        },
      }
      const readTarget = path.join(fixture.forbiddenSourceDir, 'source-sentinel.txt')
      const writeTarget = path.join(fixture.forbiddenSourceDir, 'probe-write.txt')
      const evaluated = await evaluateSandboxedCase(
        fixture,
        'source-read-write',
        { exitCode: 1, signal: null, timedOut: false, stdout: '', stderr: '', settledAfterMs: 1 },
        {
          preHashes: { [readTarget]: 'before-hash', [writeTarget]: null },
          sha256File: async (target: string) =>
            target === writeTarget ? 'unexpected-write-hash' : 'before-hash',
          readFile: async () =>
            `${JSON.stringify({
              version: 1,
              name: 'source-read-write',
              readDenied: true,
              writeDenied: true,
              readLeaked: false,
              passed: true,
            })}\n`,
        },
      )

      expect(evaluated.passed).toBe(false)
      expect(evaluated.evidence.targetUnchanged).toBe(false)
    })

    it('does not accept a generic network process failure without positive child evidence', async () => {
      const { evaluateSandboxedCase } = await probeModule()
      const fixture = {
        evidenceDir: '/private/var/tmp/probe/evidence',
        acceptedTcpConnections: 0,
        sentinels: { forbiddenSource: 'source-secret' },
      }
      const evaluated = await evaluateSandboxedCase(
        fixture,
        'loopback-tcp',
        { exitCode: 1, signal: null, timedOut: false, stdout: '', stderr: '', settledAfterMs: 1 },
        {
          readFile: async () => {
            const error = new Error('missing') as NodeJS.ErrnoException
            error.code = 'ENOENT'
            throw error
          },
        },
      )

      expect(evaluated.passed).toBe(false)
      expect(evaluated.evidence.evidenceStatus).toBe('missing')
    })

    it('requires positive per-operation evidence for descendant inheritance', async () => {
      const { evaluateSandboxedCase } = await probeModule()
      const fixture = {
        evidenceDir: '/private/var/tmp/probe/evidence',
        sentinels: {},
      }
      const records = [
        'source-read-write',
        'home-secret-read-write',
        'control-plane-read-write',
        'loopback-tcp',
      ].map((name) => ({ version: 1, name, passed: false }))
      const evaluated = await evaluateSandboxedCase(
        fixture,
        'descendant-inheritance',
        { exitCode: 0, signal: null, timedOut: false, stdout: '', stderr: '', settledAfterMs: 1 },
        { readFile: async () => `${records.map((record) => JSON.stringify(record)).join('\n')}\n` },
      )

      expect(evaluated.passed).toBe(false)
    })

    it('fails closed when bounded output evidence could not be persisted', async () => {
      const { evaluateSandboxedCase } = await probeModule()
      const fixture = {
        evidenceDir: '/private/var/tmp/probe/evidence',
        sentinels: { homeSecret: 'home-secret' },
      }
      const evaluated = await evaluateSandboxedCase(
        fixture,
        'output-capture',
        {
          exitCode: 37,
          signal: null,
          timedOut: false,
          stdout: 'probe-stdout-marker',
          stderr: 'probe-stderr-marker',
          settledAfterMs: 1,
          error: 'bounded output evidence could not be written',
        },
        {
          readFile: async () =>
            `${JSON.stringify({ version: 1, name: 'output-capture', passed: true })}\n`,
        },
      )

      expect(evaluated.passed).toBe(false)
      expect(evaluated.evidence.harnessError).toBe('process-capture-error')
    })
  })

  describe('cleanup and evidence persistence', () => {
    it('clears a positive-control heartbeat and confirms it does not reappear', async () => {
      const { verifyPostCleanupMarker } = await probeModule()
      const calls: string[] = []
      let reads = 0
      const result = await verifyPostCleanupMarker('/private/tmp/marker', {
        readFile: async () => {
          reads += 1
          if (reads === 1) return 'heartbeat'
          const error = new Error('missing') as NodeJS.ErrnoException
          error.code = 'ENOENT'
          throw error
        },
        unlink: async () => {
          calls.push('unlink')
        },
        wait: async () => {
          calls.push('wait')
        },
      })

      expect(calls).toEqual(['unlink', 'wait'])
      expect(result).toEqual({ confirmed: true, markerPresent: false })
    })

    it('detects a heartbeat that reappears after cleanup', async () => {
      const { verifyPostCleanupMarker } = await probeModule()
      const result = await verifyPostCleanupMarker('/private/tmp/marker', {
        readFile: async () => 'heartbeat',
        unlink: async () => {},
        wait: async () => {},
      })

      expect(result).toEqual({
        confirmed: false,
        markerPresent: true,
        error: 'post-cleanup descendant marker present',
      })
    })

    it('reports an uncleared process group instead of relying on the marker alone', async () => {
      const { waitForProcessGroupExit } = await probeModule()
      const result = await waitForProcessGroupExit(424244, {
        processGroupExists: () => true,
        wait: async () => {},
        attempts: 2,
      })

      expect(result).toBe(false)
    })

    it('writes a reconcilable raw evidence manifest file', async () => {
      const { writeRawEvidenceManifest } = await probeModule()
      const evidenceDir = await createTempDir()
      await writeFile(path.join(evidenceDir, 'case.ndjson'), '{"version":1}\n', { mode: 0o600 })

      const first = await writeRawEvidenceManifest(evidenceDir)
      const manifest = JSON.parse(
        await readFile(path.join(evidenceDir, 'evidence-manifest.json'), 'utf8'),
      )
      expect(manifest.version).toBe(1)
      expect(manifest.files).toEqual([expect.objectContaining({ name: 'case.ndjson', bytes: 14 })])
      expect(first).toMatch(/^[0-9a-f]{64}$/u)

      await writeFile(path.join(evidenceDir, 'case.ndjson'), '{"version":1,"changed":true}\n', {
        mode: 0o600,
      })
      expect(await writeRawEvidenceManifest(evidenceDir)).not.toBe(first)
    })

    it('persists the full private run inventory before hashing evidence', async () => {
      const { writePrivateRunEvidence } = await probeModule()
      const evidenceDir = await createTempDir()
      const report = reportFixture({
        runtimeSkippedDependencies: [{ path: '/usr/lib/missing.dylib', reason: 'unreachable' }],
      })

      await writePrivateRunEvidence(report, evidenceDir)
      const persisted = JSON.parse(
        await readFile(path.join(evidenceDir, 'probe-run-private.json'), 'utf8'),
      )
      expect(persisted.runtimeSkippedDependencies).toEqual([
        { path: '/usr/lib/missing.dylib', reason: 'unreachable' },
      ])
      expect(persisted.profile).toEqual(report.profile)
      expect(persisted.timing).toEqual(report.timing)
    })

    it('scrubs secrets before applying the 16 KiB output tail cap', async () => {
      const { scrubAndBoundOutput } = await probeModule()
      const secret = 'probe-secret-value'
      const output = scrubAndBoundOutput(Buffer.from(`${'x'.repeat(20_000)}${secret}tail-marker`), [
        secret,
      ])

      expect(Buffer.byteLength(output)).toBeLessThanOrEqual(16 * 1024)
      expect(output).not.toContain(secret)
      expect(output).toContain('[REDACTED]')
      expect(output).toContain('tail-marker')
    })
  })
})

describe('native Seatbelt boundary probe lifecycle', () => {
  const PROBE_NONCE_ENV = 'BELAY_NATIVE_SEATBELT_PROBE_NONCE'
  const SANDBOX_EXEC = '/usr/bin/sandbox-exec'

  function darwinPreflightDeps(overrides: Record<string, unknown> = {}) {
    return {
      platform: 'darwin',
      access: async () => {},
      realpath: async (value: string) => value,
      stat: async () => ({ isFile: () => true }),
      execFile: async (command: string, args: string[]) => {
        if (command === '/usr/bin/sw_vers' && args[0] === '-productVersion') {
          return { stdout: '15.0\n', stderr: '' }
        }
        if (command === '/usr/bin/uname' && args[0] === '-a') {
          return { stdout: 'Darwin probe-host 24.0.0 Darwin Kernel\n', stderr: '' }
        }
        throw new Error(`unexpected execFile: ${command} ${args.join(' ')}`)
      },
      arch: () => 'arm64',
      execPath: '/opt/homebrew/bin/node',
      resolveRuntimeClosure: async () => ({
        closure: [
          { path: '/opt/homebrew/bin/node', sha256: 'node-hash', source: 'executable' },
          { path: '/usr/lib/libSystem.B.dylib', sha256: 'lib-hash', source: 'dependency' },
        ],
        skippedDependencies: [],
      }),
      sha256File: async (filePath: string) => `${filePath}-hash`,
      randomBytes: () => Buffer.from('0123456789abcdef0123456789abcdef', 'hex'),
      ...overrides,
    }
  }

  it('exports lifecycle helpers', async () => {
    const module = await probeModule()
    expect(typeof module.createPrivateFixture).toBe('function')
    expect(typeof module.runSandboxedCase).toBe('function')
    expect(typeof module.terminateProcessGroup).toBe('function')
    expect(typeof module.runLiveProbe).toBe('function')
    expect(typeof module.runSandboxedProcessCapture).toBe('function')
  })

  describe('createPrivateFixture', () => {
    it('uses a short macOS temp prefix that leaves room for the Unix socket path', async () => {
      const { privateFixtureTempPrefix } = await probeModule()
      const prefix = privateFixtureTempPrefix(
        'darwin',
        '/private/var/folders/cz/very-long-per-user-temporary-directory/T',
      )

      expect(prefix).toBe('/tmp/belay-native-seatbelt-probe-')
      expect(path.join(prefix, '123456', 'listeners', 'probe.sock').length).toBeLessThan(104)
    })

    it('returns BLOCKED before fixture work when the host is not darwin', async () => {
      const { createPrivateFixture } = await probeModule()
      const result = await createPrivateFixture({
        ...darwinPreflightDeps(),
        platform: 'linux',
      })
      expect(result.blocked).toBe(true)
      expect(result.preflight.status).toBe('BLOCKED')
      expect(result.preflight.host.supported).toBe(false)
    })

    it('returns BLOCKED before fixture work when sandbox-exec is missing', async () => {
      const { createPrivateFixture } = await probeModule()
      const result = await createPrivateFixture({
        ...darwinPreflightDeps(),
        access: async (target: string) => {
          if (target === SANDBOX_EXEC) {
            throw new Error('missing')
          }
        },
      })
      expect(result.blocked).toBe(true)
      expect(result.preflight.status).toBe('BLOCKED')
      expect(result.preflight.substrate.available).toBe(false)
    })

    it('creates private fixture directories with mode 0700 and files with mode 0600', async () => {
      const { createPrivateFixture } = await probeModule()
      const root = await createTempDir()

      const fixture = await createPrivateFixture({
        ...darwinPreflightDeps(),
        startListeners: false,
        mkdtemp: async () => root,
      })

      expect(fixture.blocked).toBeUndefined()
      expect(fixture.root).toBe(root)
      for (const name of [
        'mirror',
        'forbidden-source',
        'fake-home',
        'control-plane',
        'listeners',
        'evidence',
      ]) {
        const directoryStat = await stat(path.join(root, name))
        expect(directoryStat.isDirectory()).toBe(true)
        expect(directoryStat.mode & 0o777).toBe(0o700)
      }
      expect(fixture.mirrorScriptPath).toBe(
        path.join(root, 'mirror', 'native-seatbelt-boundary-probe.mjs'),
      )
      const mirrorScriptStat = await stat(fixture.mirrorScriptPath)
      expect(mirrorScriptStat.mode & 0o777).toBe(0o600)
      expect(fixture.nonce).toMatch(/^[0-9a-f]{32}$/u)
      expect(fixture.profile.source).toContain('(deny default)')
    })

    it('does not reference docker in injected deps or recorded commands', async () => {
      const { createPrivateFixture } = await probeModule()
      const deps = darwinPreflightDeps()
      const serialized = JSON.stringify(deps)
      expect(serialized.toLowerCase()).not.toContain('docker')

      const fixture = await createPrivateFixture({
        ...deps,
        startListeners: false,
        mkdtemp: async () => createTempDir(),
      })
      expect(JSON.stringify(fixture).toLowerCase()).not.toContain('docker')
    })
  })

  describe('runSandboxedCase', () => {
    async function fixtureWithFakeRunner(
      runProcess: (
        command: string,
        args: string[],
        options: Record<string, unknown>,
      ) => Promise<Record<string, unknown>>,
    ) {
      const { createPrivateFixture, runSandboxedCase } = await probeModule()
      const spawnCalls: Array<{
        command: string
        args: string[]
        options: Record<string, unknown>
      }> = []
      const fixture = await createPrivateFixture({
        ...darwinPreflightDeps(),
        startListeners: false,
      })
      return {
        fixture,
        runSandboxedCase,
        spawnCalls,
        runProcess: async (command: string, args: string[], options: Record<string, unknown>) => {
          spawnCalls.push({ command, args, options })
          return await runProcess(command, args, options)
        },
      }
    }

    it('spawns sandbox-exec with an explicit environment allowlist and probe-child args', async () => {
      const { fixture, runSandboxedCase, spawnCalls, runProcess } = await fixtureWithFakeRunner(
        async () => ({
          code: 0,
          signal: null,
          timedOut: false,
          stdout: '',
          stderr: '',
        }),
      )

      const result = await runSandboxedCase(fixture, 'mirror-read-write', { deps: { runProcess } })

      expect(result.exitCode).toBe(0)
      expect(spawnCalls).toHaveLength(1)
      expect(spawnCalls[0]?.command).toBe(SANDBOX_EXEC)
      expect(spawnCalls[0]?.args).toEqual(
        expect.arrayContaining([
          '-f',
          expect.stringContaining('profile-mirror-read-write.sb'),
          fixture.nodePath,
          fixture.mirrorScriptPath,
          '--probe-child',
          fixture.nonce,
          'mirror-read-write',
        ]),
      )
      expect(Object.keys(spawnCalls[0]?.options.env ?? {}).sort()).toEqual(
        ['HOME', 'LANG', 'PATH', 'TMPDIR', PROBE_NONCE_ENV].sort(),
      )
      const spawnEnv = spawnCalls[0]?.options.env as Record<string, string> | undefined
      expect(spawnEnv?.[PROBE_NONCE_ENV]).toBe(fixture.nonce)
      expect(JSON.stringify(spawnCalls[0]).toLowerCase()).not.toContain('docker')
    })

    it('persists only scrubbed 16 KiB output tails', async () => {
      const { runSandboxedProcessCapture } = await probeModule()
      const evidenceDir = await createTempDir()
      const stdoutPath = path.join(evidenceDir, 'stdout')
      const stderrPath = path.join(evidenceDir, 'stderr')
      const secret = 'probe-secret-value'
      const result = await runSandboxedProcessCapture(
        process.execPath,
        [
          '-e',
          `process.stdout.write('${'x'.repeat(20_000)}${secret}tail-marker'); process.stderr.write('${secret}')`,
        ],
        {
          stdoutPath,
          stderrPath,
          scrubValues: [secret],
        },
      )

      const persistedStdout = await readFile(stdoutPath, 'utf8')
      const persistedStderr = await readFile(stderrPath, 'utf8')
      expect(result.stdout).toBe(persistedStdout)
      expect(result.stderr).toBe(persistedStderr)
      expect(Buffer.byteLength(persistedStdout)).toBeLessThanOrEqual(16 * 1024)
      expect(persistedStdout).not.toContain(secret)
      expect(persistedStderr).toBe('[REDACTED]')
      expect(persistedStdout).toContain('tail-marker')
    })

    it('uses the clear-and-recheck cleanup proof after a timeout', async () => {
      const { runSandboxedProcessCapture } = await probeModule()
      const listeners = new Map<string, Array<(...args: unknown[]) => void>>()
      const fakeSpawn = () => {
        const stream = {
          on: (event: string, handler: (...args: unknown[]) => void) => {
            const bucket = listeners.get(event) ?? []
            bucket.push(handler)
            listeners.set(event, bucket)
          },
        }
        const child = {
          pid: 424243,
          stdout: stream,
          stderr: stream,
          kill: () => true,
          on: (event: string, handler: (...args: unknown[]) => void) => {
            const bucket = listeners.get(event) ?? []
            bucket.push(handler)
            listeners.set(event, bucket)
          },
        }
        setTimeout(() => {
          for (const handler of listeners.get('close') ?? []) handler(null, 'SIGTERM')
        }, 5)
        return child
      }
      let reads = 0
      let cleared = false
      const result = await runSandboxedProcessCapture(process.execPath, ['-e', '0'], {
        timeoutMs: 1,
        postCleanupMarkerPath: '/private/tmp/marker',
        spawn: fakeSpawn,
        processGroupExists: () => false,
        terminateProcessGroup: () => true,
        readFile: async () => {
          reads += 1
          if (reads === 1) return 'heartbeat'
          const error = new Error('missing') as NodeJS.ErrnoException
          error.code = 'ENOENT'
          throw error
        },
        unlink: async () => {
          cleared = true
        },
        wait: async () => {},
      })

      expect(result.timedOut).toBe(true)
      expect(result.error).toBeNull()
      expect(cleared).toBe(true)
    })

    const processGroupIt = process.platform === 'win32' ? it.skip : it
    processGroupIt(
      'does not settle before the one-second SIGKILL fallback after SIGTERM timeout',
      async () => {
        const { runSandboxedProcessCapture, terminateProcessGroup } = await probeModule()
        const termSignals: string[] = []
        let groupAlive = true
        const originalKill = process.kill.bind(process)
        process.kill = ((pid: number, signal: number | string) => {
          if (pid === -424242 && signal === 0) {
            return groupAlive
          }
          if (pid === -424242 && signal === 'SIGKILL') {
            groupAlive = false
            return true
          }
          if (pid === -424242) {
            return true
          }
          return originalKill(pid, signal as NodeJS.Signals)
        }) as typeof process.kill

        const fakeSpawn = (
          _command: string,
          _args: string[],
          _options: Record<string, unknown>,
        ) => {
          const listeners = new Map<string, Array<(...args: unknown[]) => void>>()
          const child = {
            pid: 424242,
            stdout: {
              on: (event: string, handler: (...args: unknown[]) => void) => {
                const bucket = listeners.get(`stdout:${event}`) ?? []
                bucket.push(handler)
                listeners.set(`stdout:${event}`, bucket)
              },
            },
            stderr: { on: () => {} },
            on: (event: string, handler: (...args: unknown[]) => void) => {
              const bucket = listeners.get(event) ?? []
              bucket.push(handler)
              listeners.set(event, bucket)
            },
            kill: (signal: string) => {
              termSignals.push(signal)
              return true
            },
          }
          setTimeout(() => {
            for (const handler of listeners.get('stdout:data') ?? []) {
              handler(Buffer.from('ready\n'))
            }
            for (const handler of listeners.get('close') ?? []) {
              handler(null, 'SIGTERM')
            }
          }, 4_100)
          return child
        }

        try {
          const startedAt = performance.now()
          const result = await runSandboxedProcessCapture(process.execPath, ['-e', '0'], {
            timeoutMs: 4_000,
            spawn: fakeSpawn,
            terminateProcessGroup: (child: { pid?: number }, signal: NodeJS.Signals) => {
              termSignals.push(`group:${signal}`)
              return terminateProcessGroup(child, signal)
            },
          })
          const settledAfterMs = performance.now() - startedAt

          expect(result.timedOut).toBe(true)
          expect(result.signal).toBe('SIGTERM')
          expect(termSignals).toContain('group:SIGTERM')
          expect(termSignals).toContain('group:SIGKILL')
          expect(settledAfterMs).toBeGreaterThanOrEqual(4_900)
        } finally {
          process.kill = originalKill
        }
      },
      10_000,
    )
  })

  describe('runLiveProbe', () => {
    it('returns a BLOCKED report without spawning sandbox children when preflight fails', async () => {
      const { runLiveProbe } = await probeModule()
      const report = await runLiveProbe({
        ...darwinPreflightDeps(),
        platform: 'linux',
      })
      expect(report.status).toBe('BLOCKED')
      expect(report.host.supported).toBe(false)
      expect(report.cases).toEqual([])
    })

    it('preserves a terminal manifest when the live harness fails after execution starts', async () => {
      const { runLiveProbe } = await probeModule()
      const root = await createTempDir()
      const report = await runLiveProbe({
        ...darwinPreflightDeps(),
        startListeners: false,
        mkdtemp: async () => root,
        stat: async (target: string) => {
          if (target.startsWith(root)) return await stat(target)
          return { isFile: () => true }
        },
        runProcess: async () => {
          throw new Error('synthetic case runner failure')
        },
      })

      expect(report.status).toBe('NO-GO')
      expect(report.harnessError).toEqual({ phase: 'case:mirror-read-write', kind: 'Error' })
      expect(report.evidenceManifestSha256).toMatch(/^[0-9a-f]{64}$/u)
      expect(
        await readFile(path.join(root, 'evidence', 'evidence-manifest.json'), 'utf8'),
      ).toContain('probe-run-private.json')
    })
  })

  describe('paired latency benchmark', () => {
    it('computes overhead as max(0, sandboxedMs - baselineMs)', async () => {
      const { computeOverheadMs } = await probeModule()
      expect(computeOverheadMs(10, 50)).toBe(40)
      expect(computeOverheadMs(50, 10)).toBe(0)
      expect(computeOverheadMs(25, 25)).toBe(0)
    })

    it('uses nearest-rank median and p95 without rounding samples first', async () => {
      const { summarizeLatencyOverhead } = await probeModule()
      const overheadMs = Array.from({ length: 30 }, (_, index) => index + 1)
      const summary = summarizeLatencyOverhead(overheadMs)
      expect(summary.samples).toBe(30)
      expect(summary.medianOverheadMs).toBe(15)
      expect(summary.p95OverheadMs).toBe(29)
      expect(summary.thresholds).toEqual({ medianMs: 100, p95Ms: 250 })
      expect(summary.warmUpPairs).toBe(5)
    })

    it('runs five warm-ups and 30 measured pairs in alternating order', async () => {
      const { createPrivateFixture, runPairedLatencyBenchmark } = await probeModule()
      const fixture = await createPrivateFixture({
        ...darwinPreflightDeps(),
        startListeners: false,
      })
      const callOrder: Array<{ sandboxed: boolean; pairIndex?: number }> = []
      let sampleOrdinal = 0

      const latency = await runPairedLatencyBenchmark(fixture, {
        durationForSample: ({ sandboxed }: { sandboxed: boolean }) => {
          sampleOrdinal += 1
          const duration = sandboxed ? 20 + sampleOrdinal : 10 + sampleOrdinal
          callOrder.push({ sandboxed })
          return duration
        },
      })

      expect(callOrder).toHaveLength(5 * 2 + 30 * 2)
      expect(latency.pairs).toHaveLength(30)
      expect(latency.overheadMs).toHaveLength(30)
      for (const [index, pair] of latency.pairs.entries()) {
        expect(pair.baselineFirst).toBe(index % 2 === 0)
        expect(pair.overheadMs).toBe(Math.max(0, pair.sandboxedMs - pair.baselineMs))
      }
      expect(latency.medianOverheadMs).toBeGreaterThan(0)
      expect(latency.p95OverheadMs).toBeGreaterThanOrEqual(latency.medianOverheadMs)
    })

    it('maps 101 ms median overhead to NO-GO through decideProbe', async () => {
      const { decideProbe, percentile } = await probeModule()
      const overheadMs = Array.from({ length: 30 }, () => 101)
      expect(percentile(overheadMs, 0.5)).toBe(101)
      expect(
        decideProbe(
          reportFixture({
            latency: {
              samples: 30,
              medianOverheadMs: 101,
              p95OverheadMs: 101,
            },
          }),
        ),
      ).toBe('NO-GO')
    })

    it('maps 251 ms p95 overhead to NO-GO through decideProbe', async () => {
      const { decideProbe, percentile } = await probeModule()
      const overheadMs = Array.from({ length: 28 }, () => 50)
      overheadMs.push(251, 251)
      expect(percentile(overheadMs, 0.95)).toBe(251)
      expect(
        decideProbe(
          reportFixture({
            latency: {
              samples: 30,
              medianOverheadMs: 50,
              p95OverheadMs: 251,
            },
          }),
        ),
      ).toBe('NO-GO')
    })
  })

  describe('terminateProcessGroup', () => {
    const processGroupIt = process.platform === 'win32' ? it.skip : it
    processGroupIt('targets the negative pid on POSIX hosts', async () => {
      const { terminateProcessGroup } = await probeModule()
      const signals: Array<{ pid: number; signal: string }> = []
      const originalKill = process.kill.bind(process)
      process.kill = ((pid: number, signal: string) => {
        signals.push({ pid, signal })
        return true
      }) as typeof process.kill

      try {
        terminateProcessGroup({ pid: 1234, kill: () => false }, 'SIGTERM')
        expect(signals).toEqual([{ pid: -1234, signal: 'SIGTERM' }])
      } finally {
        process.kill = originalKill
      }
    })
  })
})
