#!/usr/bin/env node

import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { realpath as fsRealpath, stat as fsStat } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

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
    profile: {
      literalReadCount: report.profile.literalReads.length,
      literalExecCount: report.profile.literalExecs.length,
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
    cleanup: { confirmed: report.cleanup.confirmed },
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

async function sha256FileDefault(filePath) {
  const { createReadStream } = await import('node:fs')
  return await new Promise((resolve, reject) => {
    const hash = createHash('sha256')
    const stream = createReadStream(filePath)
    stream.on('error', reject)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('end', () => resolve(hash.digest('hex')))
  })
}

async function execFileCapture(command, args) {
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

  while (queue.length > 0) {
    const item = queue.shift()
    const canonical = await deps.realpath(item.path)
    if (visited.has(canonical)) continue
    const fileStat = await deps.stat(canonical)
    if (!fileStat.isFile()) {
      throw new Error(`runtime closure is not a file: ${canonical}`)
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

  return closure.sort((left, right) => left.path.localeCompare(right.path))
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
    requestedSubpathGrants = [],
  } = input

  const forbiddenBroadGrants = []
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
  lines.push(`(allow file-read* (subpath ${seatbeltQuote(mirrorRoot)}))`)
  lines.push(`(allow file-write* (subpath ${seatbeltQuote(mirrorRoot)}))`)
  lines.push(`(allow file-read* (literal ${seatbeltQuote(evidenceDir)}))`)
  lines.push(`(allow file-write* (literal ${seatbeltQuote(evidenceDir)}))`)

  for (const executablePath of literalExecs) {
    lines.push(`(allow process-exec (literal ${seatbeltQuote(executablePath)}))`)
    lines.push(`(allow file-read* (literal ${seatbeltQuote(executablePath)}))`)
  }

  for (const readGrant of literalReads) {
    lines.push(`(allow ${readGrant.operation} (literal ${seatbeltQuote(readGrant.path)}))`)
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
    const evidenceLiteral = `(literal ${seatbeltQuote(inventory.requiredEvidenceDir)})`
    if (!profile.source.includes(evidenceLiteral)) {
      missing.push({ kind: 'evidence-dir', path: inventory.requiredEvidenceDir })
    }
  }

  if (missing.length > 0) {
    return { status: 'NO-GO', missing }
  }
  return { status: 'GO' }
}
