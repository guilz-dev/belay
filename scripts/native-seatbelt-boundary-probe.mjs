#!/usr/bin/env node

import { execFile, spawn as nodeSpawn } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { createReadStream, writeFileSync as fsWriteFileSync } from 'node:fs'
import {
  access as fsAccess,
  appendFile as fsAppendFile,
  chmod as fsChmod,
  copyFile as fsCopyFile,
  mkdir as fsMkdir,
  mkdtemp as fsMkdtemp,
  readdir as fsReaddir,
  readFile as fsReadFile,
  realpath as fsRealpath,
  stat as fsStat,
  unlink as fsUnlink,
  writeFile as fsWriteFile,
} from 'node:fs/promises'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

const SCRIPT_PATH = fileURLToPath(import.meta.url)
const SANDBOX_EXEC = '/usr/bin/sandbox-exec'
const FIXTURE_PREFIX = 'belay-native-seatbelt-probe-'
export const PROBE_NONCE_ENV = 'BELAY_NATIVE_SEATBELT_PROBE_NONCE'
const CASE_TIMEOUT_MS = 120_000
const TIMEOUT_CASE_MS = 4_000
const SIGKILL_FALLBACK_MS = 1_000
const POST_CLEANUP_CHECK_MS = 250
const LATENCY_WARMUP_PAIRS = 5
const LATENCY_MEASURED_PAIRS = 30
const LATENCY_NOOP_CASE = 'latency-noop'
const INTERNAL_CHILD_CASES = Object.freeze(['timeout-grandchild'])
const MAX_CAPTURE_BYTES = 16 * 1024
const POST_CLEANUP_MARKER_BASENAME = 'post-cleanup-marker'
const SYSTEM_LITERALS = Object.freeze([
  { path: '/dev/null', operation: 'file-read-data' },
  { path: '/usr/lib/dyld', operation: 'file-read-data' },
])
export const PROFILE_BASELINE_IMPORTS = Object.freeze(['dyld-support.sb'])
const SYSTEM_SUBPATH_GRANTS = Object.freeze([
  { subpath: '/System/Library/OpenSSL', operation: 'file-read*', role: 'system-openssl' },
])
const GLOBAL_GRANTS = Object.freeze([
  { operation: 'mach-lookup', role: 'global-mach-lookup' },
  { operation: 'sysctl-read', role: 'global-sysctl-read' },
  { operation: 'file-read-metadata', role: 'global-file-read-metadata' },
])

export const REQUIRED_CASE_NAMES = Object.freeze([
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

export function parseCaseRecords(text) {
  const records = new Map()
  for (const line of text.split(/\r?\n/u)) {
    if (!line.trim()) continue
    const value = JSON.parse(line)
    if (
      value?.version !== 1 ||
      typeof value.name !== 'string' ||
      typeof value.passed !== 'boolean' ||
      records.has(value.name)
    ) {
      throw new Error('invalid or duplicate Seatbelt probe case record')
    }
    records.set(value.name, value)
  }
  return [...records.values()]
}

export function percentile(samples, fraction) {
  if (samples.length === 0 || fraction <= 0 || fraction > 1) {
    throw new Error('percentile requires samples and a fraction in (0, 1]')
  }
  const sorted = [...samples].sort((a, b) => a - b)
  return sorted[Math.ceil(sorted.length * fraction) - 1]
}

export function decideProbe(report) {
  if (!report.host.supported || !report.substrate.available) return 'BLOCKED'
  const observed = new Map(report.cases.map((entry) => [entry.name, entry]))
  const casesPass = REQUIRED_CASE_NAMES.every((name) => observed.get(name)?.passed === true)
  const latencyPass =
    report.latency.samples === 30 &&
    report.latency.medianOverheadMs <= 100 &&
    report.latency.p95OverheadMs <= 250
  return casesPass &&
    report.cleanup.confirmed &&
    (report.runtimeSkippedDependencies?.length ?? 0) === 0 &&
    report.profile.forbiddenBroadGrants.length === 0 &&
    latencyPass
    ? 'GO'
    : 'NO-GO'
}

export function redactProbeReport(report, evidenceDir) {
  const roleForPath = (value) => {
    if (value === evidenceDir) return '<PRIVATE_EVIDENCE_DIR>'
    if (value === '/usr/bin/sandbox-exec') return '<SANDBOX_EXEC>'
    return '<RUNTIME_FILE>'
  }
  return {
    version: 1,
    status: report.status,
    host: {
      platform: report.host.platform,
      supported: report.host.supported,
      productVersion: report.host.productVersion,
      kernel: report.host.kernel,
      arch: report.host.arch,
    },
    substrate: {
      available: report.substrate.available,
      executableRole: roleForPath(report.substrate.executable),
      sha256: report.substrate.sha256,
    },
    runtimeClosure: report.runtimeClosure.map(({ path, sha256, source }) => ({
      pathRole: roleForPath(path),
      sha256,
      source,
    })),
    runtimeSkippedDependencyCount: report.runtimeSkippedDependencies?.length ?? 0,
    profile: {
      literalReadCount: report.profile.literalReads.length,
      literalExecCount: report.profile.literalExecs.length,
      imports: report.profile.imports ?? [],
      systemSubpathRoles: (report.profile.systemSubpaths ?? []).map(({ role, operation }) => ({
        role,
        operation,
      })),
      forbiddenBroadGrants: report.profile.forbiddenBroadGrants.map(({ role, operation }) => ({
        role,
        operation,
      })),
      sourceSha256: report.profile.sourceSha256,
    },
    cases: report.cases.map(({ name, passed, evidence }) => ({
      name,
      passed,
      evidence: {
        operationDenied: evidence.operationDenied,
        exitCode: evidence.exitCode,
        signal: evidence.signal,
        timedOut: evidence.timedOut,
        markerPresent: evidence.markerPresent,
        acceptedConnections: evidence.acceptedConnections,
        targetUnchanged: evidence.targetUnchanged,
        settledAfterMs: evidence.settledAfterMs,
      },
    })),
    latency: { ...report.latency },
    timing: { ...report.timing },
    cleanup: { confirmed: report.cleanup.confirmed },
    harnessError: report.harnessError ?? null,
    evidenceManifestSha256: report.evidenceManifestSha256,
  }
}

const FORBIDDEN_BROAD_SUBPATHS = Object.freeze(['/', '/usr/local', '/opt/homebrew'])

function assertSafePath(value) {
  if (typeof value !== 'string' || /[\0\n\r]/.test(value)) {
    throw new Error('seatbelt path contains forbidden characters')
  }
}

function roleForForbiddenSubpath(subpath, homeDir) {
  if (subpath === '/') return 'root'
  if (subpath === homeDir) return 'home'
  if (subpath === '/usr/local') return 'usr-local'
  if (subpath === '/opt/homebrew') return 'opt-homebrew'
  return subpath.replace(/^\//, '').replaceAll('/', '-')
}

export function parseOtoolLibraries(stdout) {
  const libraries = []
  for (const line of stdout.split(/\r?\n/u)) {
    const match = /^\t(.+?) \(compatibility version /u.exec(line)
    if (match) {
      libraries.push(match[1])
    }
  }
  return libraries
}

export function resolveLibraryReference(reference, loaderPath, executablePath) {
  assertSafePath(reference)
  if (reference.includes('@rpath')) {
    throw new Error('unresolved @rpath library reference')
  }

  let resolved = reference
  if (resolved.includes('@loader_path')) {
    resolved = resolved.replaceAll('@loader_path', path.dirname(loaderPath))
  }
  if (resolved.includes('@executable_path')) {
    resolved = resolved.replaceAll('@executable_path', path.dirname(executablePath))
  }
  resolved = path.normalize(resolved)
  if (!path.isAbsolute(resolved)) {
    throw new Error(`library reference did not resolve to an absolute path: ${reference}`)
  }
  assertSafePath(resolved)
  return resolved
}

function assertNoDocker(value) {
  if (typeof value === 'string' && value.toLowerCase().includes('docker')) {
    throw new Error('docker is forbidden in the native Seatbelt probe')
  }
}

async function sha256FileDefault(filePath) {
  return await new Promise((resolve, reject) => {
    const hash = createHash('sha256')
    const stream = createReadStream(filePath)
    stream.on('error', reject)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('end', () => resolve(hash.digest('hex')))
  })
}

async function execFileCapture(command, args) {
  assertNoDocker(command)
  for (const arg of args) assertNoDocker(arg)
  const { stdout, stderr } = await execFileAsync(command, args, {
    encoding: 'utf8',
    maxBuffer: 10 * 1024 * 1024,
  })
  return { stdout, stderr }
}

export async function resolveRuntimeClosure(
  executable,
  deps = {
    realpath: fsRealpath,
    stat: fsStat,
    sha256File: sha256FileDefault,
    runOtool: (file) => execFileCapture('/usr/bin/otool', ['-L', file]),
  },
) {
  const executablePath = await deps.realpath(executable)
  const queue = [{ path: executablePath, source: 'executable' }]
  const visited = new Set()
  const closure = []
  const skippedDependencies = []

  while (queue.length > 0) {
    const item = queue.shift()
    let canonical
    try {
      canonical = await deps.realpath(item.path)
    } catch {
      if (item.source === 'executable') {
        throw new Error(`runtime closure executable is not reachable: ${item.path}`)
      }
      skippedDependencies.push({ path: item.path, reason: 'unreachable' })
      continue
    }
    if (visited.has(canonical)) continue
    let fileStat
    try {
      fileStat = await deps.stat(canonical)
    } catch {
      if (item.source === 'executable') {
        throw new Error(`runtime closure executable is not reachable: ${item.path}`)
      }
      skippedDependencies.push({ path: canonical, reason: 'stat-failed' })
      continue
    }
    if (!fileStat.isFile()) {
      if (item.source === 'executable') {
        throw new Error(`runtime closure is not a file: ${canonical}`)
      }
      skippedDependencies.push({ path: canonical, reason: 'not-regular-file' })
      continue
    }
    visited.add(canonical)
    closure.push({
      path: canonical,
      sha256: await deps.sha256File(canonical),
      source: item.source,
    })
    const output = await deps.runOtool(canonical)
    for (const library of parseOtoolLibraries(output.stdout)) {
      const resolved = resolveLibraryReference(library, canonical, executablePath)
      queue.push({ path: resolved, source: 'dependency' })
    }
  }

  return {
    closure: closure.sort((left, right) => left.path.localeCompare(right.path)),
    skippedDependencies,
  }
}

export function seatbeltQuote(value) {
  assertSafePath(value)
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

export function compileSeatbeltProfile(input) {
  const {
    runtimeClosure,
    mirrorRoot,
    evidenceDir,
    homeDir,
    systemLiterals = [],
    systemSubpathGrants = SYSTEM_SUBPATH_GRANTS,
    requestedSubpathGrants = [],
    baselineImports = PROFILE_BASELINE_IMPORTS,
    globalGrants = GLOBAL_GRANTS,
  } = input

  const forbiddenBroadGrants = [
    ...baselineImports.map((source) => ({
      role: `baseline-import:${source}`,
      operation: 'import',
      source,
    })),
    ...globalGrants.map(({ role, operation }) => ({ role, operation })),
    ...systemSubpathGrants.map(({ subpath, operation, role }) => ({
      role: role ?? roleForForbiddenSubpath(subpath, homeDir),
      operation,
      subpath,
    })),
  ]
  for (const grant of requestedSubpathGrants) {
    const isForbidden =
      grant.subpath === homeDir || FORBIDDEN_BROAD_SUBPATHS.includes(grant.subpath)
    if (isForbidden) {
      forbiddenBroadGrants.push({
        role: roleForForbiddenSubpath(grant.subpath, homeDir),
        operation: grant.operation,
        subpath: grant.subpath,
      })
    }
  }

  const literalExecs = runtimeClosure
    .filter((entry) => entry.source === 'executable')
    .map((entry) => entry.path)
  const literalReads = [
    ...runtimeClosure
      .filter((entry) => entry.source === 'dependency')
      .map((entry) => ({ path: entry.path, operation: 'file-read-data' })),
    ...systemLiterals.map((entry) => ({ path: entry.path, operation: entry.operation })),
  ]

  const lines = ['(version 1)', '(deny default)']
  for (const importName of baselineImports) {
    lines.push(`(import "${importName}")`)
  }
  lines.push('(allow process-fork)')
  lines.push('(allow signal (target self))')
  for (const grant of globalGrants) {
    lines.push(`(allow ${grant.operation})`)
  }
  lines.push(`(allow file-read* (subpath ${seatbeltQuote(mirrorRoot)}))`)
  lines.push(`(allow file-write* (subpath ${seatbeltQuote(mirrorRoot)}))`)
  lines.push(`(allow file-read* (subpath ${seatbeltQuote(evidenceDir)}))`)
  lines.push(`(allow file-write* (subpath ${seatbeltQuote(evidenceDir)}))`)

  for (const executablePath of literalExecs) {
    lines.push(`(allow process-exec (literal ${seatbeltQuote(executablePath)}))`)
    lines.push(`(allow file-read* (literal ${seatbeltQuote(executablePath)}))`)
  }

  for (const readGrant of literalReads) {
    lines.push(`(allow ${readGrant.operation} (literal ${seatbeltQuote(readGrant.path)}))`)
  }

  for (const grant of systemSubpathGrants) {
    lines.push(`(allow ${grant.operation} (subpath ${seatbeltQuote(grant.subpath)}))`)
  }

  for (const grant of requestedSubpathGrants) {
    const isForbidden =
      grant.subpath === homeDir || FORBIDDEN_BROAD_SUBPATHS.includes(grant.subpath)
    if (!isForbidden) {
      lines.push(`(allow ${grant.operation} (subpath ${seatbeltQuote(grant.subpath)}))`)
    }
  }

  return {
    source: `${lines.join('\n')}\n`,
    literalReads,
    literalExecs,
    mirrorRoot,
    forbiddenBroadGrants,
    imports: [...baselineImports],
    systemSubpaths: systemSubpathGrants.map(({ subpath, operation, role }) => ({
      subpath,
      operation,
      role: role ?? roleForForbiddenSubpath(subpath, homeDir),
    })),
  }
}

export function validateProfileGrantInventory(profile, inventory) {
  const readPaths = new Set(profile.literalReads.map((entry) => entry.path))
  const execPaths = new Set(profile.literalExecs)
  const missing = []

  for (const requiredPath of inventory.requiredReads ?? []) {
    if (!readPaths.has(requiredPath)) {
      missing.push({ kind: 'read', path: requiredPath })
    }
  }
  for (const requiredPath of inventory.requiredExecs ?? []) {
    if (!execPaths.has(requiredPath)) {
      missing.push({ kind: 'exec', path: requiredPath })
    }
  }
  if (inventory.requiredMirrorRoot && profile.mirrorRoot !== inventory.requiredMirrorRoot) {
    missing.push({ kind: 'mirror-root', path: inventory.requiredMirrorRoot })
  }
  if (inventory.requiredEvidenceDir) {
    const evidenceSubpath = `(subpath ${seatbeltQuote(inventory.requiredEvidenceDir)})`
    if (!profile.source.includes(evidenceSubpath)) {
      missing.push({ kind: 'evidence-dir', path: inventory.requiredEvidenceDir })
    }
  }

  if (missing.length > 0) {
    return { status: 'NO-GO', missing }
  }
  return { status: 'GO' }
}

/** Terminate the whole POSIX probe process group, falling back to its direct child elsewhere. */
export function terminateProcessGroup(child, signal) {
  if (process.platform !== 'win32' && child.pid) {
    try {
      process.kill(-child.pid, signal)
      return true
    } catch {
      // Fall through to the direct child if no separate process group exists yet.
    }
  }
  return child.kill(signal)
}

function processGroupExists(pid) {
  if (process.platform === 'win32' || !pid) return false
  try {
    process.kill(-pid, 0)
    return true
  } catch {
    return false
  }
}

export async function waitForProcessGroupExit(pid, deps = {}) {
  const groupExists = deps.processGroupExists ?? processGroupExists
  const wait = deps.wait ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)))
  const attempts = deps.attempts ?? 20
  const intervalMs = deps.intervalMs ?? 10
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (!groupExists(pid)) return true
    await wait(intervalMs)
  }
  return !groupExists(pid)
}

export function buildProbeEnv(fixture) {
  return {
    PATH: process.env.PATH ?? '/usr/bin:/bin',
    TMPDIR: fixture.root,
    HOME: fixture.fakeHomeDir,
    LANG: process.env.LANG ?? 'C',
    [PROBE_NONCE_ENV]: fixture.nonce,
  }
}

export async function runPreflight(deps = {}) {
  const platform = deps.platform ?? process.platform
  const host = {
    platform,
    supported: platform === 'darwin',
    productVersion: null,
    kernel: null,
    arch: deps.arch?.() ?? os.arch(),
  }

  if (platform !== 'darwin') {
    return {
      status: 'BLOCKED',
      host,
      substrate: { available: false, executable: SANDBOX_EXEC, sha256: null },
      runtimeClosure: [],
      skippedDependencies: [],
      nodePath: null,
      nodeSha256: null,
    }
  }

  const access = deps.access ?? fsAccess
  try {
    await access(SANDBOX_EXEC)
  } catch {
    return {
      status: 'BLOCKED',
      host,
      substrate: { available: false, executable: SANDBOX_EXEC, sha256: null },
      runtimeClosure: [],
      skippedDependencies: [],
      nodePath: null,
      nodeSha256: null,
    }
  }

  const execFileFn = deps.execFile ?? execFileCapture
  const swVers = await execFileFn('/usr/bin/sw_vers', ['-productVersion'])
  const uname = await execFileFn('/usr/bin/uname', ['-a'])
  host.productVersion = swVers.stdout.trim()
  host.kernel = uname.stdout.trim().split(/\s+/u)[2] ?? uname.stdout.trim()

  const sha256File = deps.sha256File ?? sha256FileDefault
  const substrateSha256 = await sha256File(SANDBOX_EXEC)
  const nodePath = await (deps.realpath ?? fsRealpath)(deps.execPath ?? process.execPath)
  const resolveClosure = deps.resolveRuntimeClosure ?? resolveRuntimeClosure
  const { closure: runtimeClosure, skippedDependencies } = await resolveClosure(nodePath, {
    realpath: deps.realpath ?? fsRealpath,
    stat: deps.stat ?? fsStat,
    sha256File,
    runOtool: deps.runOtool ?? ((file) => execFileCapture('/usr/bin/otool', ['-L', file])),
  })

  const recordedNode = runtimeClosure.find((entry) => entry.source === 'executable')
  if (!recordedNode || recordedNode.path !== nodePath) {
    return {
      status: 'BLOCKED',
      host,
      substrate: { available: true, executable: SANDBOX_EXEC, sha256: substrateSha256 },
      runtimeClosure,
      skippedDependencies,
      nodePath,
      nodeSha256: null,
    }
  }

  return {
    status: 'READY',
    host,
    substrate: { available: true, executable: SANDBOX_EXEC, sha256: substrateSha256 },
    runtimeClosure,
    skippedDependencies,
    nodePath,
    nodeSha256: recordedNode.sha256,
  }
}

async function writePrivateFile(deps, target, contents, mode = 0o600) {
  await deps.writeFile(target, contents, {
    mode,
    encoding: typeof contents === 'string' ? 'utf8' : undefined,
  })
  await deps.chmod(target, mode)
}

async function ensurePrivateDir(deps, target) {
  await deps.mkdir(target, { recursive: true, mode: 0o700 })
  await deps.chmod(target, 0o700)
}

function fixtureManifest(fixture) {
  return {
    version: 1,
    nonce: fixture.nonce,
    root: fixture.root,
    mirrorDir: fixture.mirrorDir,
    forbiddenSourceDir: fixture.forbiddenSourceDir,
    fakeHomeDir: fixture.fakeHomeDir,
    controlPlaneDir: fixture.controlPlaneDir,
    listenersDir: fixture.listenersDir,
    evidenceDir: fixture.evidenceDir,
    mirrorScriptPath: fixture.mirrorScriptPath,
    absoluteForbiddenPath: fixture.absoluteForbiddenPath,
    tcpPort: fixture.tcpPort,
    unixSocketPath: fixture.unixSocketPath,
    postCleanupMarkerPath: fixture.postCleanupMarkerPath,
  }
}

/** Mirror-visible manifest excludes sentinel values so sandboxed code cannot read secrets from JSON. */
export function mirrorFixtureManifest(fixture) {
  return fixtureManifest(fixture)
}

export async function createPrivateFixture(deps = {}) {
  const preflight = await runPreflight(deps)
  if (preflight.status === 'BLOCKED') {
    return { blocked: true, preflight }
  }

  const mkdtemp = deps.mkdtemp ?? fsMkdtemp
  const mkdir = deps.mkdir ?? fsMkdir
  const chmod = deps.chmod ?? fsChmod
  const writeFile = deps.writeFile ?? fsWriteFile
  const copyFile = deps.copyFile ?? fsCopyFile
  const readFile = deps.readFile ?? fsReadFile
  const random = deps.randomBytes ?? randomBytes
  const realpath = deps.realpath ?? fsRealpath
  const localDeps = { mkdir, chmod, writeFile, copyFile, readFile }

  const root = await mkdtemp(path.join(os.tmpdir(), FIXTURE_PREFIX))
  let mirrorDir = path.join(root, 'mirror')
  let forbiddenSourceDir = path.join(root, 'forbidden-source')
  let fakeHomeDir = path.join(root, 'fake-home')
  let controlPlaneDir = path.join(root, 'control-plane')
  let listenersDir = path.join(root, 'listeners')
  let evidenceDir = path.join(root, 'evidence')
  let absoluteForbiddenPath = path.join(root, 'absolute-forbidden', 'target')
  let unixSocketPath = path.join(listenersDir, 'probe.sock')

  for (const directory of [
    mirrorDir,
    forbiddenSourceDir,
    fakeHomeDir,
    controlPlaneDir,
    listenersDir,
    evidenceDir,
    path.dirname(absoluteForbiddenPath),
  ]) {
    await ensurePrivateDir(localDeps, directory)
  }

  const canonicalRoot = await realpath(root)
  mirrorDir = await realpath(mirrorDir)
  forbiddenSourceDir = await realpath(forbiddenSourceDir)
  fakeHomeDir = await realpath(fakeHomeDir)
  controlPlaneDir = await realpath(controlPlaneDir)
  listenersDir = await realpath(listenersDir)
  evidenceDir = await realpath(evidenceDir)
  const absoluteForbiddenDir = await realpath(path.dirname(absoluteForbiddenPath))
  absoluteForbiddenPath = path.join(absoluteForbiddenDir, 'target')
  const postCleanupMarkerPath = path.join(evidenceDir, POST_CLEANUP_MARKER_BASENAME)
  unixSocketPath = path.join(listenersDir, 'probe.sock')

  const sentinels = {
    mirror: random(16).toString('hex'),
    forbiddenSource: random(16).toString('hex'),
    homeSecret: random(16).toString('hex'),
    controlPlane: random(16).toString('hex'),
    absoluteForbidden: random(16).toString('hex'),
  }

  await writePrivateFile(localDeps, path.join(mirrorDir, 'mirror-sentinel.txt'), sentinels.mirror)
  await writePrivateFile(
    localDeps,
    path.join(forbiddenSourceDir, 'source-sentinel.txt'),
    sentinels.forbiddenSource,
  )
  await writePrivateFile(localDeps, path.join(fakeHomeDir, '.secret'), sentinels.homeSecret)
  await writePrivateFile(
    localDeps,
    path.join(controlPlaneDir, 'control-sentinel.txt'),
    sentinels.controlPlane,
  )
  await writePrivateFile(localDeps, absoluteForbiddenPath, sentinels.absoluteForbidden)

  const scriptSource = deps.scriptPath ?? SCRIPT_PATH
  const mirrorScriptPath = path.join(mirrorDir, 'native-seatbelt-boundary-probe.mjs')
  await copyFile(scriptSource, mirrorScriptPath)
  await chmod(mirrorScriptPath, 0o600)

  const nonce = random(16).toString('hex')
  const nodePath = preflight.nodePath
  const profileCompiled = compileSeatbeltProfile({
    runtimeClosure: preflight.runtimeClosure,
    mirrorRoot: mirrorDir,
    evidenceDir,
    homeDir: fakeHomeDir,
    systemLiterals: SYSTEM_LITERALS,
  })
  profileCompiled.sourceSha256 = createHash('sha256').update(profileCompiled.source).digest('hex')

  const fixture = {
    root: canonicalRoot,
    mirrorDir,
    forbiddenSourceDir,
    fakeHomeDir,
    controlPlaneDir,
    listenersDir,
    evidenceDir,
    mirrorScriptPath,
    absoluteForbiddenPath,
    postCleanupMarkerPath,
    unixSocketPath,
    nonce,
    nodePath,
    sentinels,
    preflight,
    profile: profileCompiled,
    tcpPort: null,
    tcpServer: null,
    unixServer: null,
    acceptedTcpConnections: 0,
    acceptedUnixConnections: 0,
  }

  await writePrivateFile(
    localDeps,
    path.join(mirrorDir, 'probe-fixture.json'),
    JSON.stringify(mirrorFixtureManifest(fixture)),
  )

  if (deps.startListeners !== false) {
    await startFixtureListeners(fixture, deps)
  }

  return fixture
}

async function startFixtureListeners(fixture, deps = {}) {
  if (deps.startListeners === false) return fixture

  fixture.tcpServer = net.createServer((socket) => {
    fixture.acceptedTcpConnections += 1
    socket.end()
  })
  await new Promise((resolve, reject) => {
    fixture.tcpServer.once('error', reject)
    fixture.tcpServer.listen(0, '127.0.0.1', () => {
      fixture.tcpPort = fixture.tcpServer.address().port
      resolve()
    })
  })

  fixture.unixServer = net.createServer((socket) => {
    fixture.acceptedUnixConnections += 1
    socket.end()
  })
  await new Promise((resolve, reject) => {
    fixture.unixServer.once('error', reject)
    fixture.unixServer.listen(fixture.unixSocketPath, () => resolve())
  })

  const manifestPath = path.join(fixture.mirrorDir, 'probe-fixture.json')
  const writeFile = deps.writeFile ?? fsWriteFile
  const chmod = deps.chmod ?? fsChmod
  await writeFile(manifestPath, JSON.stringify(mirrorFixtureManifest(fixture)), {
    encoding: 'utf8',
    mode: 0o600,
  })
  await chmod(manifestPath, 0o600)
  return fixture
}

async function stopFixtureListeners(fixture) {
  await Promise.all([
    fixture.tcpServer
      ? new Promise((resolve) => fixture.tcpServer.close(() => resolve()))
      : Promise.resolve(),
    fixture.unixServer
      ? new Promise((resolve) => fixture.unixServer.close(() => resolve()))
      : Promise.resolve(),
  ])
}

/**
 * Capture sandboxed child output in memory while optionally writing evidence files.
 */
function appendBoundedTail(current, chunk, limit) {
  const combined = Buffer.concat([current, Buffer.from(chunk)])
  return combined.length <= limit ? combined : combined.subarray(combined.length - limit)
}

export function scrubAndBoundOutput(raw, secrets = []) {
  let scrubbed = Buffer.from(raw).toString('utf8')
  for (const secret of secrets) {
    if (typeof secret === 'string' && secret.length > 0) {
      scrubbed = scrubbed.replaceAll(secret, '[REDACTED]')
    }
  }
  const encoded = Buffer.from(scrubbed)
  return encoded.length <= MAX_CAPTURE_BYTES
    ? scrubbed
    : encoded.subarray(encoded.length - MAX_CAPTURE_BYTES).toString('utf8')
}

function isMissingFileError(error) {
  return error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT'
}

export async function verifyPostCleanupMarker(markerPath, deps = {}) {
  const readFile = deps.readFile ?? fsReadFile
  const unlink = deps.unlink ?? fsUnlink
  const wait = deps.wait ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)))

  try {
    const positiveControl = await readFile(markerPath, 'utf8')
    if (!positiveControl.trim()) {
      return { confirmed: false, markerPresent: false, error: 'post-cleanup marker was empty' }
    }
  } catch (error) {
    return {
      confirmed: false,
      markerPresent: false,
      error: isMissingFileError(error)
        ? 'post-cleanup marker was never observed'
        : 'post-cleanup marker could not be read',
    }
  }

  try {
    await unlink(markerPath)
  } catch (error) {
    if (!isMissingFileError(error)) {
      return {
        confirmed: false,
        markerPresent: true,
        error: 'post-cleanup marker could not be cleared',
      }
    }
  }
  await wait(POST_CLEANUP_CHECK_MS)

  try {
    const marker = await readFile(markerPath, 'utf8')
    if (marker.trim()) {
      return {
        confirmed: false,
        markerPresent: true,
        error: 'post-cleanup descendant marker present',
      }
    }
    return { confirmed: false, markerPresent: false, error: 'post-cleanup marker reappeared empty' }
  } catch (error) {
    if (isMissingFileError(error)) {
      return { confirmed: true, markerPresent: false }
    }
    return {
      confirmed: false,
      markerPresent: false,
      error: 'post-cleanup marker could not be rechecked',
    }
  }
}

export function runSandboxedProcessCapture(command, args, options = {}) {
  assertNoDocker(command)
  for (const arg of args) assertNoDocker(arg)

  const spawnFn = options.spawn ?? nodeSpawn
  const terminate = options.terminateProcessGroup ?? terminateProcessGroup
  const groupExists = options.processGroupExists ?? ((pid) => processGroupExists(pid))
  const longestSecretBytes = Math.max(
    0,
    ...(options.scrubValues ?? []).map((value) =>
      typeof value === 'string' ? Buffer.byteLength(value) : 0,
    ),
  )
  const rawCaptureLimit = MAX_CAPTURE_BYTES + longestSecretBytes

  return new Promise((resolve) => {
    const child = spawnFn(command, args, {
      cwd: options.cwd,
      detached: process.platform !== 'win32',
      env: options.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = Buffer.alloc(0)
    let stderr = Buffer.alloc(0)
    let timedOut = false
    let settled = false
    let forceKill = null
    let resolveForceKill
    let forceKillDone = Promise.resolve()
    const startedAt = performance.now()

    const timeout = options.timeoutMs
      ? setTimeout(() => {
          timedOut = true
          terminate(child, 'SIGTERM')
          forceKillDone = new Promise((wait) => {
            resolveForceKill = wait
          })
          forceKill = setTimeout(() => {
            if (groupExists(child.pid)) {
              terminate(child, 'SIGKILL')
            }
            forceKill = null
            resolveForceKill()
          }, SIGKILL_FALLBACK_MS)
        }, options.timeoutMs)
      : null

    const settle = async ({ code, signal, error }) => {
      if (settled) return
      settled = true
      if (timeout) clearTimeout(timeout)
      if (timedOut) {
        if (forceKill && groupExists(child.pid)) {
          await forceKillDone
        } else if (forceKill) {
          clearTimeout(forceKill)
          forceKill = null
          resolveForceKill?.()
        }
        const groupExited = await waitForProcessGroupExit(child.pid, {
          processGroupExists: groupExists,
          wait: options.wait,
          attempts: options.groupExitAttempts,
          intervalMs: options.groupExitIntervalMs,
        })
        if (!groupExited) error = error ?? 'post-cleanup process group still exists'
      } else if (forceKill) {
        clearTimeout(forceKill)
        forceKill = null
        resolveForceKill?.()
      }

      if (options.postCleanupMarkerPath && timedOut) {
        const cleanup = await verifyPostCleanupMarker(options.postCleanupMarkerPath, {
          readFile: options.readFile,
          unlink: options.unlink,
          wait: options.wait,
        })
        if (!cleanup.confirmed) error = error ?? cleanup.error
      }

      const scrubValues = options.scrubValues ?? []
      const scrubbedStdout = scrubAndBoundOutput(stdout, scrubValues)
      const scrubbedStderr = scrubAndBoundOutput(stderr, scrubValues)
      const writeFile = options.writeFile ?? fsWriteFile
      try {
        await Promise.all([
          options.stdoutPath
            ? writeFile(options.stdoutPath, scrubbedStdout, { encoding: 'utf8', mode: 0o600 })
            : Promise.resolve(),
          options.stderrPath
            ? writeFile(options.stderrPath, scrubbedStderr, { encoding: 'utf8', mode: 0o600 })
            : Promise.resolve(),
        ])
      } catch {
        error = error ?? 'bounded output evidence could not be written'
      }
      resolve({
        code,
        signal,
        error,
        timedOut,
        stdout: scrubbedStdout,
        stderr: scrubbedStderr,
        settledAfterMs: performance.now() - startedAt,
      })
    }

    child.stdout?.on('data', (chunk) => {
      stdout = appendBoundedTail(stdout, chunk, rawCaptureLimit)
    })
    child.stderr?.on('data', (chunk) => {
      stderr = appendBoundedTail(stderr, chunk, rawCaptureLimit)
    })
    child.on('error', (error) => settle({ code: null, signal: null, error: error.message }))
    child.on('close', (code, signal) => settle({ code, signal, error: null }))
  })
}

export async function runSandboxedCase(fixture, caseName, options = {}) {
  if (!REQUIRED_CASE_NAMES.includes(caseName)) {
    throw new Error(`unknown Seatbelt probe case: ${caseName}`)
  }

  const writeFile = options.deps?.writeFile ?? fsWriteFile
  const chmod = options.deps?.chmod ?? fsChmod
  const profilePath = path.join(fixture.evidenceDir, `profile-${caseName}.sb`)
  await writeFile(profilePath, fixture.profile.source, { encoding: 'utf8', mode: 0o600 })
  await chmod(profilePath, 0o600)

  const stdoutPath = path.join(fixture.evidenceDir, `${caseName}.stdout`)
  const stderrPath = path.join(fixture.evidenceDir, `${caseName}.stderr`)
  const env = buildProbeEnv(fixture)
  const timeoutMs =
    options.timeoutMs ?? (caseName === 'timeout-process-group' ? TIMEOUT_CASE_MS : CASE_TIMEOUT_MS)
  const runProcess =
    options.deps?.runProcess ??
    ((command, args, runOptions) =>
      runSandboxedProcessCapture(command, args, {
        ...runOptions,
        terminateProcessGroup: options.deps?.terminateProcessGroup,
        spawn: options.deps?.spawn,
        processGroupExists: options.deps?.processGroupExists,
        writeFile: options.deps?.writeFile,
        unlink: options.deps?.unlink,
        wait: options.deps?.wait,
      }))

  const startedAt = performance.now()
  const result = await runProcess(
    SANDBOX_EXEC,
    [
      '-f',
      profilePath,
      fixture.nodePath,
      fixture.mirrorScriptPath,
      '--probe-child',
      fixture.nonce,
      caseName,
    ],
    {
      cwd: fixture.root,
      env,
      stdoutPath,
      stderrPath,
      timeoutMs,
      postCleanupMarkerPath:
        caseName === 'timeout-process-group' ? fixture.postCleanupMarkerPath : undefined,
      readFile: options.deps?.readFile,
      unlink: options.deps?.unlink,
      wait: options.deps?.wait,
      writeFile: options.deps?.writeFile,
      scrubValues: Object.values(fixture.sentinels),
    },
  )

  return {
    exitCode: result.code,
    signal: result.signal,
    timedOut: result.timedOut,
    stdout: result.stdout,
    stderr: result.stderr,
    settledAfterMs: result.settledAfterMs ?? performance.now() - startedAt,
    error: result.error ?? null,
  }
}

async function readSentinelHash(deps, target) {
  try {
    return await (deps.sha256File ?? sha256FileDefault)(target)
  } catch {
    return null
  }
}

function outputContainsSentinel(output, sentinel) {
  return typeof output === 'string' && output.includes(sentinel)
}

function capturedOutputContainsAnySentinel(runResult, sentinels) {
  return Object.values(sentinels).some(
    (sentinel) =>
      outputContainsSentinel(runResult.stdout, sentinel) ||
      outputContainsSentinel(runResult.stderr, sentinel),
  )
}

const PRE_HASH_CASE_PATHS = {
  'mirror-read-write': (fixture) => [path.join(fixture.mirrorDir, 'mirror-sentinel.txt')],
  'source-read-write': (fixture) => [
    path.join(fixture.forbiddenSourceDir, 'source-sentinel.txt'),
    path.join(fixture.forbiddenSourceDir, 'probe-write.txt'),
  ],
  'home-secret-read-write': (fixture) => [
    path.join(fixture.fakeHomeDir, '.secret'),
    path.join(fixture.fakeHomeDir, 'probe-write.txt'),
  ],
  'control-plane-read-write': (fixture) => [
    path.join(fixture.controlPlaneDir, 'control-sentinel.txt'),
    path.join(fixture.controlPlaneDir, 'probe-write.txt'),
  ],
  'absolute-path-read-write': (fixture) => [
    fixture.absoluteForbiddenPath,
    `${fixture.absoluteForbiddenPath}.probe-write`,
  ],
}

export async function capturePreCaseHashes(fixture, caseName, deps = {}) {
  const pathsForCase = PRE_HASH_CASE_PATHS[caseName]
  if (!pathsForCase) {
    return {}
  }
  const sha256File = deps.sha256File ?? sha256FileDefault
  const hashes = {}
  for (const target of pathsForCase(fixture)) {
    hashes[target] = await readSentinelHash({ sha256File }, target)
  }
  return hashes
}

export async function readCaseEvidenceRecords(fixture, caseName, readFile = fsReadFile) {
  const evidencePath = path.join(fixture.evidenceDir, `${caseName}.ndjson`)
  try {
    const text = await readFile(evidencePath, 'utf8')
    if (!text.trim()) {
      return { status: 'empty', records: [] }
    }
    return { status: 'ok', records: parseCaseRecords(text) }
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
      return { status: 'missing', records: [] }
    }
    throw error
  }
}

export async function writeRawEvidenceManifest(evidenceDir, deps = {}) {
  const readdir = deps.readdir ?? fsReaddir
  const stat = deps.stat ?? fsStat
  const sha256File = deps.sha256File ?? sha256FileDefault
  const writeFile = deps.writeFile ?? fsWriteFile
  const entries = await readdir(evidenceDir)
  const files = []
  for (const name of entries.sort()) {
    if (name === 'evidence-manifest.json') continue
    const fullPath = path.join(evidenceDir, name)
    const fileStat = await stat(fullPath)
    if (!fileStat.isFile()) continue
    files.push({
      name,
      sha256: await sha256File(fullPath),
      bytes: fileStat.size,
    })
  }
  const payload = { version: 1, files }
  const manifestSha256 = createHash('sha256').update(JSON.stringify(payload)).digest('hex')
  await writeFile(
    path.join(evidenceDir, 'evidence-manifest.json'),
    `${JSON.stringify({ ...payload, manifestSha256 }, null, 2)}\n`,
    { encoding: 'utf8', mode: 0o600 },
  )
  return manifestSha256
}

export async function buildRawEvidenceManifestSha256(evidenceDir, deps = {}) {
  return await writeRawEvidenceManifest(evidenceDir, deps)
}

export async function writePrivateRunEvidence(report, evidenceDir, deps = {}) {
  const writeFile = deps.writeFile ?? fsWriteFile
  const privateReport = {
    version: 1,
    host: report.host,
    substrate: report.substrate,
    runtimeClosure: report.runtimeClosure,
    runtimeSkippedDependencies: report.runtimeSkippedDependencies ?? [],
    profile: report.profile,
    cases: report.cases,
    latency: report.latency,
    timing: report.timing,
    cleanup: report.cleanup,
    harnessError: report.harnessError ?? null,
  }
  await writeFile(
    path.join(evidenceDir, 'probe-run-private.json'),
    `${JSON.stringify(privateReport, null, 2)}\n`,
    { encoding: 'utf8', mode: 0o600 },
  )
}

export async function evaluateSandboxedCase(fixture, caseName, runResult, deps = {}) {
  const readFile = deps.readFile ?? fsReadFile
  const evidenceResult = await readCaseEvidenceRecords(fixture, caseName, readFile)
  const records = evidenceResult.records
  const record = records.find((entry) => entry.name === caseName)
  const evidence = {
    operationDenied: false,
    exitCode: runResult.exitCode,
    signal: runResult.signal,
    timedOut: runResult.timedOut,
    markerPresent: false,
    acceptedConnections: 0,
    targetUnchanged: true,
    settledAfterMs: runResult.settledAfterMs,
    evidenceStatus: evidenceResult.status,
  }

  let passed = false
  const childEvidenceOk = evidenceResult.status === 'ok'

  switch (caseName) {
    case 'mirror-read-write': {
      const sentinelPath = path.join(fixture.mirrorDir, 'mirror-sentinel.txt')
      const mirrorOutputPath = path.join(fixture.mirrorDir, 'mirror-output.txt')
      const before = deps.preHashes?.[sentinelPath] ?? null
      const after = await readSentinelHash(deps, sentinelPath)
      const outputWritten = await readSentinelHash(deps, mirrorOutputPath)
      evidence.operationDenied = runResult.exitCode !== 0
      evidence.markerPresent = before !== null && before === after && outputWritten !== null
      passed =
        childEvidenceOk &&
        runResult.exitCode === 0 &&
        before !== null &&
        after !== null &&
        before === after &&
        outputWritten !== null &&
        !outputContainsSentinel(runResult.stdout, fixture.sentinels.mirror)
      break
    }
    case 'source-read-write':
    case 'home-secret-read-write':
    case 'control-plane-read-write':
    case 'absolute-path-read-write': {
      const paths = {
        'source-read-write': path.join(fixture.forbiddenSourceDir, 'source-sentinel.txt'),
        'home-secret-read-write': path.join(fixture.fakeHomeDir, '.secret'),
        'control-plane-read-write': path.join(fixture.controlPlaneDir, 'control-sentinel.txt'),
        'absolute-path-read-write': fixture.absoluteForbiddenPath,
      }
      const sentinels = {
        'source-read-write': fixture.sentinels.forbiddenSource,
        'home-secret-read-write': fixture.sentinels.homeSecret,
        'control-plane-read-write': fixture.sentinels.controlPlane,
        'absolute-path-read-write': fixture.sentinels.absoluteForbidden,
      }
      const target = paths[caseName]
      const writeTargets = {
        'source-read-write': path.join(fixture.forbiddenSourceDir, 'probe-write.txt'),
        'home-secret-read-write': path.join(fixture.fakeHomeDir, 'probe-write.txt'),
        'control-plane-read-write': path.join(fixture.controlPlaneDir, 'probe-write.txt'),
        'absolute-path-read-write': `${fixture.absoluteForbiddenPath}.probe-write`,
      }
      const writeTarget = writeTargets[caseName]
      const sentinel = sentinels[caseName]
      const before = deps.preHashes?.[target] ?? null
      const after = await readSentinelHash(deps, target)
      const writeBefore = deps.preHashes?.[writeTarget] ?? null
      const writeAfter = await readSentinelHash(deps, writeTarget)
      const readDenied = record?.readDenied === true
      const writeDenied = record?.writeDenied === true
      const readLeaked = record?.readLeaked === true
      evidence.operationDenied = readDenied && writeDenied && runResult.exitCode === 1
      evidence.targetUnchanged =
        before !== null && after !== null && before === after && writeBefore === writeAfter
      evidence.markerPresent =
        readLeaked ||
        outputContainsSentinel(runResult.stdout, sentinel) ||
        outputContainsSentinel(runResult.stderr, sentinel) ||
        records.some((entry) => outputContainsSentinel(JSON.stringify(entry), sentinel))
      passed =
        childEvidenceOk &&
        evidence.operationDenied &&
        evidence.targetUnchanged &&
        !evidence.markerPresent
      break
    }
    case 'loopback-tcp': {
      evidence.operationDenied =
        record?.attempted === true && record?.connectionDenied === true && record?.passed === true
      evidence.acceptedConnections = fixture.acceptedTcpConnections
      passed =
        childEvidenceOk &&
        evidence.operationDenied &&
        runResult.exitCode === 1 &&
        evidence.acceptedConnections === 0 &&
        !capturedOutputContainsAnySentinel(runResult, fixture.sentinels)
      break
    }
    case 'unix-socket': {
      evidence.operationDenied =
        record?.attempted === true && record?.connectionDenied === true && record?.passed === true
      evidence.acceptedConnections = fixture.acceptedUnixConnections
      passed =
        childEvidenceOk &&
        evidence.operationDenied &&
        runResult.exitCode === 1 &&
        evidence.acceptedConnections === 0 &&
        !capturedOutputContainsAnySentinel(runResult, fixture.sentinels)
      break
    }
    case 'descendant-inheritance': {
      const forbiddenRecords = records.filter((entry) => entry.name !== 'descendant-inheritance')
      evidence.operationDenied = forbiddenRecords.every((entry) => entry.passed === true)
      evidence.markerPresent = forbiddenRecords.some((entry) => entry.markerPresent === true)
      passed =
        childEvidenceOk &&
        runResult.exitCode === 0 &&
        forbiddenRecords.length === 4 &&
        evidence.operationDenied &&
        !evidence.markerPresent
      break
    }
    case 'timeout-process-group': {
      evidence.operationDenied = runResult.timedOut === true
      evidence.timedOut = runResult.timedOut === true
      let markerAbsent = false
      try {
        const marker = await readFile(fixture.postCleanupMarkerPath, 'utf8')
        markerAbsent = !marker.trim()
      } catch (error) {
        markerAbsent =
          error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT'
        if (!markerAbsent) {
          evidence.harnessError = 'marker-read-failed'
        }
      }
      evidence.markerPresent = !markerAbsent
      passed =
        runResult.timedOut === true &&
        runResult.error === null &&
        markerAbsent &&
        evidence.harnessError === undefined
      break
    }
    case 'output-capture': {
      evidence.operationDenied = false
      passed =
        childEvidenceOk &&
        runResult.exitCode === 37 &&
        runResult.stdout.includes('probe-stdout-marker') &&
        runResult.stderr.includes('probe-stderr-marker') &&
        !capturedOutputContainsAnySentinel(runResult, fixture.sentinels)
      break
    }
    default:
      passed = false
  }

  if (runResult.error !== null && runResult.error !== undefined) {
    evidence.harnessError = 'process-capture-error'
    passed = false
  }

  return { name: caseName, passed, evidence }
}

export function computeOverheadMs(baselineMs, sandboxedMs) {
  return Math.max(0, sandboxedMs - baselineMs)
}

export function summarizeLatencyOverhead(overheadSamples) {
  if (overheadSamples.length !== LATENCY_MEASURED_PAIRS) {
    throw new Error(`latency benchmark requires ${LATENCY_MEASURED_PAIRS} overhead samples`)
  }
  return {
    samples: overheadSamples.length,
    medianOverheadMs: percentile(overheadSamples, 0.5),
    p95OverheadMs: percentile(overheadSamples, 0.95),
    overheadMs: overheadSamples,
    thresholds: { medianMs: 100, p95Ms: 250 },
    warmUpPairs: LATENCY_WARMUP_PAIRS,
  }
}

export async function runLatencyNoopSample(fixture, sandboxed, options = {}) {
  const measure =
    options.measure ??
    (async () => {
      const runProcess =
        options.deps?.runProcess ??
        ((command, args, runOptions) =>
          runSandboxedProcessCapture(command, args, {
            ...runOptions,
            spawn: options.deps?.spawn,
            terminateProcessGroup: options.deps?.terminateProcessGroup,
            processGroupExists: options.deps?.processGroupExists,
          }))

      const profilePath = path.join(fixture.evidenceDir, 'profile-latency-noop.sb')
      const writeFile = options.deps?.writeFile ?? fsWriteFile
      const chmod = options.deps?.chmod ?? fsChmod
      if (sandboxed) {
        await writeFile(profilePath, fixture.profile.source, { encoding: 'utf8', mode: 0o600 })
        await chmod(profilePath, 0o600)
      }

      const startedAt = performance.now()

      const childArgs = [
        fixture.mirrorScriptPath,
        '--probe-child',
        fixture.nonce,
        LATENCY_NOOP_CASE,
      ]
      const result = await runProcess(
        sandboxed ? SANDBOX_EXEC : fixture.nodePath,
        sandboxed ? ['-f', profilePath, fixture.nodePath, ...childArgs] : childArgs,
        {
          cwd: fixture.root,
          env: buildProbeEnv(fixture),
        },
      )
      if (result.code !== 0) {
        throw new Error(
          `latency noop sample failed (${sandboxed ? 'sandboxed' : 'baseline'}): exit ${result.code}`,
        )
      }
      return performance.now() - startedAt
    })

  return await measure({ sandboxed, fixture })
}

export async function runPairedLatencyBenchmark(fixture, options = {}) {
  const pairs = []
  const overheadMs = []
  let sampleOrdinal = 0

  const nextDuration = (sandboxed) => {
    if (options.durationForSample) {
      return options.durationForSample({ sampleOrdinal, sandboxed })
    }
    return undefined
  }

  const measureWithDuration = async ({ sandboxed }) => {
    const injected = nextDuration(sandboxed)
    if (injected !== undefined) {
      sampleOrdinal += 1
      return injected
    }
    return await runLatencyNoopSample(fixture, sandboxed, options)
  }

  for (let warmUp = 0; warmUp < LATENCY_WARMUP_PAIRS; warmUp += 1) {
    const baselineFirst = warmUp % 2 === 0
    if (baselineFirst) {
      await measureWithDuration({ sandboxed: false })
      await measureWithDuration({ sandboxed: true })
    } else {
      await measureWithDuration({ sandboxed: true })
      await measureWithDuration({ sandboxed: false })
    }
  }

  for (let pairIndex = 0; pairIndex < LATENCY_MEASURED_PAIRS; pairIndex += 1) {
    const baselineFirst = pairIndex % 2 === 0
    let baselineMs
    let sandboxedMs
    if (baselineFirst) {
      baselineMs = await measureWithDuration({ sandboxed: false })
      sandboxedMs = await measureWithDuration({ sandboxed: true })
    } else {
      sandboxedMs = await measureWithDuration({ sandboxed: true })
      baselineMs = await measureWithDuration({ sandboxed: false })
    }
    const overhead = computeOverheadMs(baselineMs, sandboxedMs)
    pairs.push({
      pairIndex,
      baselineMs,
      sandboxedMs,
      overheadMs: overhead,
      baselineFirst,
    })
    overheadMs.push(overhead)
  }

  return {
    ...summarizeLatencyOverhead(overheadMs),
    pairs,
  }
}

async function writeLatencyEvidence(fixture, latency, appendFile = fsAppendFile) {
  const evidencePath = path.join(fixture.evidenceDir, 'latency.ndjson')
  for (const pair of latency.pairs) {
    await appendFile(evidencePath, `${JSON.stringify({ version: 1, ...pair })}\n`, {
      mode: 0o600,
    })
  }
}

export async function runLiveProbe(deps = {}) {
  const preparationStartedAt = performance.now()
  const fixtureResult = await createPrivateFixture({ ...deps, startListeners: deps.startListeners })
  const mirrorPreparationMs = performance.now() - preparationStartedAt
  if (fixtureResult.blocked) {
    return {
      version: 1,
      status: 'BLOCKED',
      host: fixtureResult.preflight.host,
      substrate: fixtureResult.preflight.substrate,
      runtimeClosure: fixtureResult.preflight.runtimeClosure,
      profile: {
        literalReads: [],
        literalExecs: [],
        forbiddenBroadGrants: [],
        sourceSha256: null,
      },
      cases: [],
      latency: { samples: 0, medianOverheadMs: 0, p95OverheadMs: 0 },
      cleanup: { confirmed: false },
      timing: { mirrorPreparationMs, caseCommandMs: 0, benchmarkCommandMs: 0 },
      evidenceManifestSha256: null,
      evidenceDir: null,
    }
  }

  const fixture = fixtureResult
  const caseResults = []
  let caseCommandMs = 0
  let cleanupConfirmed = true
  let activePhase = 'fixture-ready'
  let harnessError = null
  let latency = {
    samples: 0,
    medianOverheadMs: 0,
    p95OverheadMs: 0,
    overheadMs: [],
    pairs: [],
    thresholds: { medianMs: 100, p95Ms: 250 },
    warmUpPairs: LATENCY_WARMUP_PAIRS,
  }

  try {
    for (const caseName of REQUIRED_CASE_NAMES) {
      activePhase = `case:${caseName}`
      const preHashes = await capturePreCaseHashes(fixture, caseName, deps)
      const runResult = await runSandboxedCase(fixture, caseName, { deps })
      caseCommandMs += runResult.settledAfterMs
      const evaluated = await evaluateSandboxedCase(fixture, caseName, runResult, {
        ...deps,
        preHashes,
      })
      caseResults.push(evaluated)
      if (caseName === 'timeout-process-group' && !evaluated.passed) {
        cleanupConfirmed = false
      }
    }

    activePhase = 'latency-benchmark'
    latency = await runPairedLatencyBenchmark(fixture, { deps })
    activePhase = 'latency-evidence'
    await writeLatencyEvidence(fixture, latency, deps.appendFile ?? fsAppendFile)
  } catch (error) {
    const candidateKind = error instanceof Error ? error.name : 'UnknownError'
    harnessError = {
      phase: activePhase,
      kind: /^[A-Za-z][A-Za-z0-9]*$/u.test(candidateKind) ? candidateKind : 'UnknownError',
    }
    cleanupConfirmed = false
  }

  try {
    await stopFixtureListeners(fixture)
  } catch (error) {
    const candidateKind = error instanceof Error ? error.name : 'UnknownError'
    harnessError ??= {
      phase: 'listener-cleanup',
      kind: /^[A-Za-z][A-Za-z0-9]*$/u.test(candidateKind) ? candidateKind : 'UnknownError',
    }
    cleanupConfirmed = false
  }

  const report = {
    version: 1,
    status: 'PENDING',
    host: fixture.preflight.host,
    substrate: fixture.preflight.substrate,
    runtimeClosure: fixture.preflight.runtimeClosure,
    runtimeSkippedDependencies: fixture.preflight.skippedDependencies ?? [],
    profile: {
      literalReads: fixture.profile.literalReads,
      literalExecs: fixture.profile.literalExecs,
      forbiddenBroadGrants: fixture.profile.forbiddenBroadGrants,
      imports: fixture.profile.imports,
      systemSubpaths: fixture.profile.systemSubpaths,
      sourceSha256: fixture.profile.sourceSha256,
    },
    cases: caseResults,
    latency,
    timing: {
      mirrorPreparationMs,
      caseCommandMs,
      benchmarkCommandMs: latency.pairs.reduce(
        (total, pair) => total + pair.baselineMs + pair.sandboxedMs,
        0,
      ),
    },
    cleanup: { confirmed: cleanupConfirmed },
    harnessError,
    evidenceManifestSha256: null,
    evidenceDir: fixture.evidenceDir,
  }
  await writePrivateRunEvidence(report, fixture.evidenceDir, deps)
  report.evidenceManifestSha256 = await writeRawEvidenceManifest(fixture.evidenceDir, deps)
  report.status = decideProbe(report)
  return report
}

async function loadFixtureManifest(mirrorDir) {
  const manifestPath = path.join(mirrorDir, 'probe-fixture.json')
  const text = await fsReadFile(manifestPath, 'utf8')
  return JSON.parse(text)
}

async function appendCaseEvidence(evidenceDir, caseName, record) {
  const evidencePath = path.join(evidenceDir, `${caseName}.ndjson`)
  await fsAppendFile(evidencePath, `${JSON.stringify(record)}\n`, { mode: 0o600 })
}

async function appendOperationEvidence(evidenceDir, caseName, record, parentCase) {
  await appendCaseEvidence(evidenceDir, caseName, record)
  if (parentCase) {
    await appendCaseEvidence(evidenceDir, parentCase, record)
  }
}

async function tryReadFile(filePath) {
  try {
    return await fsReadFile(filePath, 'utf8')
  } catch (error) {
    return { error: error.code ?? 'read-denied' }
  }
}

async function tryWriteFile(filePath, contents) {
  try {
    await fsWriteFile(filePath, contents, { mode: 0o600 })
    return { ok: true }
  } catch (error) {
    return { error: error.code ?? 'write-denied' }
  }
}

async function runForbiddenOperation(
  manifest,
  operationName,
  readTarget,
  writeTarget,
  parentEvidenceCase,
) {
  const readResult = await tryReadFile(readTarget)
  const writeResult = await tryWriteFile(writeTarget, 'probe-write-attempt')
  const readDenied = typeof readResult !== 'string'
  const writeDenied = writeResult.ok !== true
  const readLeaked = typeof readResult === 'string'
  const evidenceRecord = {
    version: 1,
    name: operationName,
    readDenied,
    writeDenied,
    readLeaked,
    passed: readDenied && writeDenied && !readLeaked,
  }
  await appendOperationEvidence(
    manifest.evidenceDir,
    operationName,
    evidenceRecord,
    parentEvidenceCase,
  )
  return {
    denied: readDenied && writeDenied,
    readDenied,
    writeDenied,
    readLeaked,
  }
}

export async function runProbeChildEntry(nonce, caseName, parentEvidenceCase) {
  if (process.env[PROBE_NONCE_ENV] !== nonce) {
    process.exitCode = 91
    return
  }
  if (parentEvidenceCase !== undefined && parentEvidenceCase !== 'descendant-inheritance') {
    process.exitCode = 94
    return
  }
  if (caseName === LATENCY_NOOP_CASE) {
    process.exitCode = 0
    return
  }
  if (!REQUIRED_CASE_NAMES.includes(caseName) && !INTERNAL_CHILD_CASES.includes(caseName)) {
    process.exitCode = 92
    return
  }

  const mirrorDir = path.dirname(SCRIPT_PATH)
  const manifest = await loadFixtureManifest(mirrorDir)

  switch (caseName) {
    case 'mirror-read-write': {
      const readTarget = path.join(manifest.mirrorDir, 'mirror-sentinel.txt')
      const writeTarget = path.join(manifest.mirrorDir, 'mirror-output.txt')
      const contents = await tryReadFile(readTarget)
      const writeResult = await tryWriteFile(
        writeTarget,
        typeof contents === 'string' ? contents : '',
      )
      await appendCaseEvidence(manifest.evidenceDir, caseName, {
        version: 1,
        name: caseName,
        passed: typeof contents === 'string' && writeResult.ok === true,
      })
      process.exitCode = typeof contents === 'string' && writeResult.ok === true ? 0 : 1
      return
    }
    case 'source-read-write': {
      const result = await runForbiddenOperation(
        manifest,
        caseName,
        path.join(manifest.forbiddenSourceDir, 'source-sentinel.txt'),
        path.join(manifest.forbiddenSourceDir, 'probe-write.txt'),
        parentEvidenceCase,
      )
      process.exitCode = result.denied && !result.readLeaked ? 1 : 0
      return
    }
    case 'home-secret-read-write': {
      const result = await runForbiddenOperation(
        manifest,
        caseName,
        path.join(manifest.fakeHomeDir, '.secret'),
        path.join(manifest.fakeHomeDir, 'probe-write.txt'),
        parentEvidenceCase,
      )
      process.exitCode = result.denied && !result.readLeaked ? 1 : 0
      return
    }
    case 'control-plane-read-write': {
      const result = await runForbiddenOperation(
        manifest,
        caseName,
        path.join(manifest.controlPlaneDir, 'control-sentinel.txt'),
        path.join(manifest.controlPlaneDir, 'probe-write.txt'),
        parentEvidenceCase,
      )
      process.exitCode = result.denied && !result.readLeaked ? 1 : 0
      return
    }
    case 'absolute-path-read-write': {
      const result = await runForbiddenOperation(
        manifest,
        caseName,
        manifest.absoluteForbiddenPath,
        `${manifest.absoluteForbiddenPath}.probe-write`,
        parentEvidenceCase,
      )
      process.exitCode = result.denied && !result.readLeaked ? 1 : 0
      return
    }
    case 'loopback-tcp': {
      let denied = true
      try {
        await new Promise((resolve) => {
          const socket = net.connect(manifest.tcpPort, '127.0.0.1')
          socket.once('connect', () => {
            denied = false
            socket.end()
            resolve()
          })
          socket.once('error', () => resolve())
        })
      } catch {
        // Expected denial path.
      }
      await appendOperationEvidence(
        manifest.evidenceDir,
        caseName,
        {
          version: 1,
          name: caseName,
          attempted: true,
          connectionDenied: denied,
          passed: denied,
        },
        parentEvidenceCase,
      )
      process.exitCode = denied ? 1 : 0
      return
    }
    case 'unix-socket': {
      let denied = true
      try {
        await new Promise((resolve) => {
          const socket = net.connect(manifest.unixSocketPath)
          socket.once('connect', () => {
            denied = false
            socket.end()
            resolve()
          })
          socket.once('error', () => resolve())
        })
      } catch {
        // Expected denial path.
      }
      await appendOperationEvidence(
        manifest.evidenceDir,
        caseName,
        {
          version: 1,
          name: caseName,
          attempted: true,
          connectionDenied: denied,
          passed: denied,
        },
        parentEvidenceCase,
      )
      process.exitCode = denied ? 1 : 0
      return
    }
    case 'descendant-inheritance': {
      const forbiddenCases = [
        'source-read-write',
        'home-secret-read-write',
        'control-plane-read-write',
        'loopback-tcp',
      ]
      for (const forbiddenCase of forbiddenCases) {
        const exitCode = await new Promise((resolve) => {
          const child = nodeSpawn(
            process.execPath,
            [
              manifest.mirrorScriptPath,
              '--probe-child',
              nonce,
              forbiddenCase,
              '--parent-evidence-case',
              caseName,
            ],
            {
              stdio: ['ignore', 'pipe', 'pipe'],
              env: buildProbeEnv({
                root: manifest.root,
                fakeHomeDir: manifest.fakeHomeDir,
                nonce: manifest.nonce,
              }),
            },
          )
          child.on('close', (code) => resolve(code ?? 1))
        })
        if (exitCode !== 1) process.exitCode = 1
      }
      process.exitCode ??= 0
      return
    }
    case 'timeout-grandchild': {
      process.on('SIGTERM', () => {})
      setInterval(() => {
        try {
          fsWriteFileSync(manifest.postCleanupMarkerPath, 'survived')
        } catch {
          // Expected when cleanup succeeds.
        }
      }, 50)
      setInterval(() => {}, 1000)
      return
    }
    case 'timeout-process-group': {
      const child = nodeSpawn(
        process.execPath,
        [manifest.mirrorScriptPath, '--probe-child', nonce, 'timeout-grandchild'],
        {
          stdio: ['ignore', 'pipe', 'pipe'],
          env: buildProbeEnv({
            root: manifest.root,
            fakeHomeDir: manifest.fakeHomeDir,
            nonce: manifest.nonce,
          }),
        },
      )
      child.unref()
      process.stdout.write(`spawned:${child.pid}\n`)
      setInterval(() => {}, 1000)
      return
    }
    case 'output-capture': {
      process.stdout.write('probe-stdout-marker\n')
      process.stderr.write('probe-stderr-marker\n')
      await appendCaseEvidence(manifest.evidenceDir, caseName, {
        version: 1,
        name: caseName,
        passed: true,
      })
      process.exitCode = 37
      return
    }
    default:
      process.exitCode = 93
  }
}

async function main() {
  const childIndex = process.argv.indexOf('--probe-child')
  if (childIndex !== -1) {
    const nonce = process.argv[childIndex + 1]
    const caseName = process.argv[childIndex + 2]
    const parentIndex = process.argv.indexOf('--parent-evidence-case')
    const parentEvidenceCase = parentIndex === -1 ? undefined : process.argv[parentIndex + 1]
    await runProbeChildEntry(nonce, caseName, parentEvidenceCase)
    return
  }

  if (process.argv.includes('--live')) {
    const report = await runLiveProbe()
    process.stderr.write(`evidenceDir=${report.evidenceDir}\n`)
    process.stderr.write(`evidenceManifestSha256=${report.evidenceManifestSha256}\n`)
    const redacted = redactProbeReport(report, report.evidenceDir)
    process.stdout.write(`${JSON.stringify(redacted, null, 2)}\n`)
  }
}

const executedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : ''
if (import.meta.url === executedPath) {
  main().catch((error) => {
    process.stderr.write(
      `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
    )
    process.exitCode = 1
  })
}
