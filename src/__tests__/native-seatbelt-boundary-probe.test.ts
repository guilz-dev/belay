import { mkdtemp, rm, stat } from 'node:fs/promises'
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

      const closure = await resolveRuntimeClosure(symlinkNodePath, {
        realpath: async (value: string) => (value === symlinkNodePath ? canonicalNodePath : value),
        stat: async () => ({ isFile: () => true }),
        sha256File: async (value: string) =>
          value === canonicalNodePath ? 'node-hash' : 'libuv-hash',
        runOtool: async (value: string) => ({
          stdout: value === canonicalNodePath ? otoolOutput : libOtoolOutput,
        }),
      })

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

      const closure = await resolveRuntimeClosure(left, {
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

      const closure = await resolveRuntimeClosure(executablePath, {
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

      const closure = await resolveRuntimeClosure(executablePath, {
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

    it('compiles a deny-by-default profile with mirror and literal grants only', async () => {
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
      expect(profile.source).toContain(`(allow file-read* (literal ${seatbeltQuote(evidenceDir)}))`)
      expect(profile.source).toContain(
        `(allow file-write* (literal ${seatbeltQuote(evidenceDir)}))`,
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
      expect(profile.forbiddenBroadGrants).toEqual([])
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
      resolveRuntimeClosure: async () => [
        { path: '/opt/homebrew/bin/node', sha256: 'node-hash', source: 'executable' },
        { path: '/usr/lib/libSystem.B.dylib', sha256: 'lib-hash', source: 'dependency' },
      ],
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
        durationForSample: ({ sandboxed }) => {
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
