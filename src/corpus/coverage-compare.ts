import type { CoverageContextId } from './coverage-matrix.js'
import type { CoverageProbeReport } from './coverage-probe.js'

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

function indexResults(report: CoverageProbeReport): Map<string, CoverageProbeReport['results'][number]> {
  const map = new Map<string, CoverageProbeReport['results'][number]>()
  for (const result of report.results) {
    map.set(resultKey(result.caseId, result.context), result)
  }
  return map
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
  for (const [context, afterHash] of afterContextHashes) {
    const beforeHash = beforeContextHashes.get(context)
    if (beforeHash !== undefined && beforeHash !== afterHash) {
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
    const classifierChanged =
      before.actual.verdict !== after.actual.verdict ||
      before.actual.reason !== after.actual.reason

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
