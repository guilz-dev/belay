#!/usr/bin/env node

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
