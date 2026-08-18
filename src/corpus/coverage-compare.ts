import type { CoverageContextId } from './coverage-matrix.js'
import type { HookVerdict } from '../core/types.js'
import type { CoverageCaseResult, CoverageProbeReport } from './coverage-probe.js'

const SUPPORTED_COMPARE_REPORT_SCHEMA_VERSIONS = [1, 2] as const

export class CoverageCompareError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CoverageCompareError'
  }
}

export type CoverageCompareKind =
  | 'fixture_change'
  | 'classifier_drift'
  | 'added'
  | 'removed'

export interface CoverageCompareEntry {
  caseId: string
  context: CoverageContextId
  kind: CoverageCompareKind
  beforeVerdict?: string
  afterVerdict?: string
  beforeReason?: string
  afterReason?: string
  beforeCommandHash?: string
  afterCommandHash?: string
  beforeExpectationHash?: string | null
  afterExpectationHash?: string | null
}

export interface CoverageContextConfigDrift {
  context: CoverageContextId
  beforeHash: string
  afterHash: string
}

export interface CoverageCompareReport {
  schemaVersion: 1
  matrixHashChanged: boolean
  beforeMatrixHash: string
  afterMatrixHash: string
  configDrift: CoverageContextConfigDrift[]
  entries: CoverageCompareEntry[]
}

function resultKey(caseId: string, context: CoverageContextId): string {
  return `${caseId}::${context}`
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function normalizeCaseResult(raw: unknown): CoverageCaseResult {
  if (!isRecord(raw)) {
    throw new CoverageCompareError('--compare baseline result row is invalid')
  }
  if (typeof raw.caseId !== 'string' || typeof raw.context !== 'string') {
    throw new CoverageCompareError('--compare baseline result row is missing caseId or context')
  }
  if (!isRecord(raw.actual)) {
    throw new CoverageCompareError('--compare baseline result row is missing actual verdict')
  }
  const expectationHash =
    raw.expectationHash === undefined || raw.expectationHash === null
      ? null
      : String(raw.expectationHash)
  const verdict = String(raw.actual.verdict) as HookVerdict

  return {
    ...(raw as unknown as CoverageCaseResult),
    expectationHash,
    actual: {
      verdict,
      reason: String(raw.actual.reason ?? ''),
      fingerprint: String(raw.actual.fingerprint ?? ''),
    },
  }
}

export function parseCoverageProbeReportForCompare(raw: unknown): CoverageProbeReport {
  if (!isRecord(raw)) {
    throw new CoverageCompareError('--compare baseline must be a JSON object')
  }
  if (!Array.isArray(raw.results)) {
    throw new CoverageCompareError('--compare baseline is missing results[]')
  }
  const schemaVersion = raw.reportSchemaVersion ?? 1
  if (
    typeof schemaVersion !== 'number' ||
    !SUPPORTED_COMPARE_REPORT_SCHEMA_VERSIONS.includes(
      schemaVersion as (typeof SUPPORTED_COMPARE_REPORT_SCHEMA_VERSIONS)[number],
    )
  ) {
    throw new CoverageCompareError(
      `--compare baseline reportSchemaVersion is unsupported: ${JSON.stringify(raw.reportSchemaVersion)}`,
    )
  }
  if (!Array.isArray(raw.contexts)) {
    throw new CoverageCompareError('--compare baseline is missing contexts[]')
  }

  return {
    ...(raw as unknown as CoverageProbeReport),
    reportSchemaVersion: schemaVersion as CoverageProbeReport['reportSchemaVersion'],
    results: raw.results.map(normalizeCaseResult),
  }
}

export function compareBaselineWarnings(
  baseline: CoverageProbeReport,
  current: CoverageProbeReport,
): string[] {
  const warnings: string[] = []
  if (baseline.reportSchemaVersion !== current.reportSchemaVersion) {
    warnings.push(
      `baseline schema v${baseline.reportSchemaVersion} differs from current v${current.reportSchemaVersion}`,
    )
  }

  const baselineContexts = new Set(baseline.contexts.map((context) => context.id))
  const currentContexts = new Set(current.contexts.map((context) => context.id))
  const onlyBaseline = [...baselineContexts].filter((context) => !currentContexts.has(context))
  const onlyCurrent = [...currentContexts].filter((context) => !baselineContexts.has(context))
  if (onlyBaseline.length > 0 || onlyCurrent.length > 0) {
    warnings.push(
      `context set differs (baseline-only: ${onlyBaseline.join(', ') || '-'}; current-only: ${onlyCurrent.join(', ') || '-'})`,
    )
  }

  return warnings
}

function indexResults(report: CoverageProbeReport): Map<string, CoverageCaseResult> {
  const map = new Map<string, CoverageCaseResult>()
  for (const result of report.results) {
    map.set(resultKey(result.caseId, result.context), result)
  }
  return map
}

function classifierOutputChanged(before: CoverageCaseResult, after: CoverageCaseResult): boolean {
  return (
    before.actual.verdict !== after.actual.verdict ||
    before.actual.reason !== after.actual.reason ||
    before.actual.fingerprint !== after.actual.fingerprint
  )
}

export function compareCoverageReports(
  baseline: CoverageProbeReport,
  current: CoverageProbeReport,
): CoverageCompareReport {
  const beforeMatrixHash = baseline.matrixHash
  const afterMatrixHash = current.matrixHash
  const matrixHashChanged = beforeMatrixHash !== afterMatrixHash

  const beforeContextHashes = new Map(
    baseline.contexts.map((context) => [context.id, context.resolvedConfigHash]),
  )
  const afterContextHashes = new Map(
    current.contexts.map((context) => [context.id, context.resolvedConfigHash]),
  )

  const configDrift: CoverageContextConfigDrift[] = []
  const sharedContexts = new Set([...beforeContextHashes.keys(), ...afterContextHashes.keys()])
  for (const context of sharedContexts) {
    const beforeHash = beforeContextHashes.get(context)
    const afterHash = afterContextHashes.get(context)
    if (beforeHash !== undefined && afterHash !== undefined && beforeHash !== afterHash) {
      configDrift.push({ context, beforeHash, afterHash })
    }
  }

  const beforeResults = indexResults(baseline)
  const afterResults = indexResults(current)
  const keys = new Set([...beforeResults.keys(), ...afterResults.keys()])
  const entries: CoverageCompareEntry[] = []

  for (const key of [...keys].sort()) {
    const before = beforeResults.get(key)
    const after = afterResults.get(key)
    if (!before && after) {
      entries.push({
        caseId: after.caseId,
        context: after.context,
        kind: 'added',
        afterVerdict: after.actual.verdict,
        afterReason: after.actual.reason,
        afterCommandHash: after.commandHash,
        afterExpectationHash: after.expectationHash ?? null,
      })
      continue
    }
    if (before && !after) {
      entries.push({
        caseId: before.caseId,
        context: before.context,
        kind: 'removed',
        beforeVerdict: before.actual.verdict,
        beforeReason: before.actual.reason,
        beforeCommandHash: before.commandHash,
        beforeExpectationHash: before.expectationHash ?? null,
      })
      continue
    }
    if (!before || !after) {
      continue
    }

    const fixtureChanged =
      before.commandHash !== after.commandHash ||
      (before.expectationHash ?? null) !== (after.expectationHash ?? null)
    const classifierChanged = classifierOutputChanged(before, after)

    if (fixtureChanged) {
      entries.push({
        caseId: after.caseId,
        context: after.context,
        kind: 'fixture_change',
        beforeVerdict: before.actual.verdict,
        afterVerdict: after.actual.verdict,
        beforeReason: before.actual.reason,
        afterReason: after.actual.reason,
        beforeCommandHash: before.commandHash,
        afterCommandHash: after.commandHash,
        beforeExpectationHash: before.expectationHash ?? null,
        afterExpectationHash: after.expectationHash ?? null,
      })
      continue
    }

    if (classifierChanged) {
      entries.push({
        caseId: after.caseId,
        context: after.context,
        kind: 'classifier_drift',
        beforeVerdict: before.actual.verdict,
        afterVerdict: after.actual.verdict,
        beforeReason: before.actual.reason,
        afterReason: after.actual.reason,
        beforeCommandHash: before.commandHash,
        afterCommandHash: after.commandHash,
        beforeExpectationHash: before.expectationHash ?? null,
        afterExpectationHash: after.expectationHash ?? null,
      })
    }
  }

  return {
    schemaVersion: 1,
    matrixHashChanged,
    beforeMatrixHash,
    afterMatrixHash,
    configDrift,
    entries,
  }
}

export function formatCoverageCompareReport(report: CoverageCompareReport): string {
  const lines: string[] = []
  lines.push('Coverage probe compare')
  lines.push(`matrix hash changed: ${report.matrixHashChanged ? 'yes' : 'no'}`)
  if (report.configDrift.length > 0) {
    lines.push('config drift (warning only):')
    for (const drift of report.configDrift) {
      lines.push(`  - ${drift.context}: ${drift.beforeHash.slice(0, 8)} -> ${drift.afterHash.slice(0, 8)}`)
    }
  }
  if (report.entries.length === 0) {
    lines.push('no fixture or classifier differences')
    return lines.join('\n')
  }
  lines.push(`differences: ${report.entries.length}`)
  for (const entry of report.entries) {
    lines.push(
      `  - [${entry.kind}] ${entry.caseId} (${entry.context}) ${entry.beforeVerdict ?? '-'} -> ${entry.afterVerdict ?? '-'}`,
    )
  }
  return lines.join('\n')
}
