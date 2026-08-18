import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { classifierOptionsFromConfig } from '../core/config.js'
import type { ClassifyResult, HookVerdict } from '../core/types.js'
import { classifyShell } from '../core/verdict/adapter.js'
import {
  compareCoverageReports,
  formatCoverageCompareReport,
} from './coverage-compare.js'
import {
  buildCoverageEvalContexts,
  type CoverageEvalContext,
  hashStableJson,
  resolvedConfigHash,
} from './coverage-contexts.js'
import type { ConfigProvenanceEntry } from '../core/config-layers.js'
import {
  assertKnownContextIds,
  DEFAULT_PROBE_CONTEXT_IDS,
  type CoverageContextId,
  type CoverageExpectation,
  type CoverageMatrix,
  CoverageMatrixSchemaError,
  defaultCoverageMatrixPath,
  flattenCoverageCases,
  loadCoverageMatrix,
} from './coverage-matrix.js'

export class CoverageProbeCliError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CoverageProbeCliError'
  }
}

export const COVERAGE_PROBE_REPORT_SCHEMA_VERSION = 2 as const

export type ClassifyFn = (
  command: string,
  evalContext: CoverageEvalContext,
) => Promise<ClassifyResult>

export interface CoverageProbeOptions {
  repoRoot?: string
  matrixPath?: string
  contextIds?: CoverageContextId[]
  filters?: string[]
  repeat?: number
  outputDir?: string
  json?: boolean
  classifyFn?: ClassifyFn
}

export interface CoverageCaseResult {
  caseId: string
  groupId: string
  command: string
  commandHash: string
  context: CoverageContextId
  tags: string[]
  observeOnly: boolean
  expectation?: CoverageExpectation
  expectationHash: string | null
  actual: {
    verdict: HookVerdict
    reason: string
    fingerprint: string
  }
  match: boolean | null
}

export interface CoverageProbeReport {
  reportSchemaVersion: typeof COVERAGE_PROBE_REPORT_SCHEMA_VERSION
  generatedAt: string
  packageVersion: string | null
  gitSha: string | null
  matrixPath: string
  matrixHash: string
  repeat: number
  driftRuns: number
  contexts: Array<{
    id: CoverageContextId
    cwd: string
    repoRoot: string
    resolvedConfigHash: string
    configProvenance?: ConfigProvenanceEntry[]
  }>
  summary: {
    total: number
    observeOnly: number
    matched: number
    mismatched: number
    filteredEmpty: boolean
    byGroup: Record<
      string,
      { total: number; matched: number; mismatched: number; observeOnly: number }
    >
    byTag: Record<
      string,
      { total: number; matched: number; mismatched: number; observeOnly: number }
    >
  }
  results: CoverageCaseResult[]
  mismatches: CoverageCaseResult[]
}

function defaultRepoRoot(): string {
  return path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
}

export const defaultClassifyFn: ClassifyFn = async (command, evalContext) => {
  const options = {
    ...classifierOptionsFromConfig(evalContext.config),
    ...evalContext.options,
  }
  return classifyShell(command, evalContext.cwd, evalContext.repoRoot, evalContext.config, options)
}

function matchesExpectation(expectation: CoverageExpectation, actual: ClassifyResult): boolean {
  if (actual.verdict !== expectation.verdict) {
    return false
  }
  if (expectation.reason !== undefined && actual.reason !== expectation.reason) {
    return false
  }
  return true
}

function caseMatchesFilter(
  testCase: { id: string; groupId: string; tags: string[] },
  filters: string[],
): boolean {
  if (filters.length === 0) {
    return true
  }
  const filterSet = new Set(filters)
  if (filterSet.has(testCase.groupId) || filterSet.has(testCase.id)) {
    return true
  }
  return testCase.tags.some((tag) => filterSet.has(tag))
}

async function readPackageVersion(repoRoot: string): Promise<string | null> {
  try {
    const raw = JSON.parse(await readFile(path.join(repoRoot, 'package.json'), 'utf8')) as {
      version?: string
    }
    return raw.version ?? null
  } catch {
    return null
  }
}

function readGitSha(): string | null {
  return process.env.GITHUB_SHA ?? process.env.GIT_SHA ?? null
}

function initBucket(): {
  total: number
  matched: number
  mismatched: number
  observeOnly: number
} {
  return { total: 0, matched: 0, mismatched: 0, observeOnly: 0 }
}

function recordBucket(bucket: ReturnType<typeof initBucket>, result: CoverageCaseResult): void {
  bucket.total += 1
  if (result.observeOnly) {
    bucket.observeOnly += 1
    return
  }
  if (result.match) {
    bucket.matched += 1
  } else {
    bucket.mismatched += 1
  }
}

export async function evaluateCoverageMatrix(
  matrix: CoverageMatrix,
  options: CoverageProbeOptions = {},
): Promise<CoverageCaseResult[]> {
  const classifyFn = options.classifyFn ?? defaultClassifyFn
  const contextIds = options.contextIds ?? [...DEFAULT_PROBE_CONTEXT_IDS]
  const repoRoot = path.resolve(options.repoRoot ?? defaultRepoRoot())
  const filters = options.filters ?? []
  const contexts = await buildCoverageEvalContexts(contextIds, repoRoot)
  const cases = flattenCoverageCases(matrix).filter((testCase) =>
    caseMatchesFilter(testCase, filters),
  )

  const results: CoverageCaseResult[] = []

  for (const testCase of cases) {
    for (const evalContext of contexts) {
      const expectation = testCase.expectations?.[evalContext.id]
      const observeOnly = expectation === undefined
      const actual = await classifyFn(testCase.command, evalContext)
      const match =
        observeOnly || expectation === undefined ? null : matchesExpectation(expectation, actual)

      results.push({
        caseId: testCase.id,
        groupId: testCase.groupId,
        command: testCase.command,
        commandHash: hashStableJson(testCase.command),
        context: evalContext.id,
        tags: testCase.tags,
        observeOnly,
        expectation,
        expectationHash: expectation ? hashStableJson(expectation) : null,
        actual: {
          verdict: actual.verdict,
          reason: actual.reason,
          fingerprint: actual.fingerprint,
        },
        match,
      })
    }
  }

  return results
}

function summarizeResults(
  results: CoverageCaseResult[],
  filters: string[],
): CoverageProbeReport['summary'] {
  const summary: CoverageProbeReport['summary'] = {
    total: results.length,
    observeOnly: 0,
    matched: 0,
    mismatched: 0,
    filteredEmpty: filters.length > 0 && results.length === 0,
    byGroup: {},
    byTag: {},
  }

  for (const result of results) {
    if (result.observeOnly) {
      summary.observeOnly += 1
    } else if (result.match) {
      summary.matched += 1
    } else {
      summary.mismatched += 1
    }

    if (!summary.byGroup[result.groupId]) {
      summary.byGroup[result.groupId] = initBucket()
    }
    recordBucket(summary.byGroup[result.groupId], result)

    for (const tag of result.tags) {
      if (!summary.byTag[tag]) {
        summary.byTag[tag] = initBucket()
      }
      recordBucket(summary.byTag[tag], result)
    }
  }

  return summary
}

function resultsSignature(results: CoverageCaseResult[]): string {
  return hashStableJson(
    results.map((result) => ({
      caseId: result.caseId,
      context: result.context,
      verdict: result.actual.verdict,
      reason: result.actual.reason,
      fingerprint: result.actual.fingerprint,
    })),
  )
}

export async function runCoverageProbe(
  options: CoverageProbeOptions = {},
): Promise<CoverageProbeReport> {
  const repoRoot = path.resolve(options.repoRoot ?? defaultRepoRoot())
  const matrixPath = path.resolve(options.matrixPath ?? defaultCoverageMatrixPath(repoRoot))
  const matrix = await loadCoverageMatrix(matrixPath)
  const contextIds = options.contextIds ?? [...DEFAULT_PROBE_CONTEXT_IDS]
  const contexts = await buildCoverageEvalContexts(contextIds, repoRoot)
  const repeat = Math.max(1, options.repeat ?? 1)
  const filters = options.filters ?? []

  let results = await evaluateCoverageMatrix(matrix, options)
  let driftRuns = 0
  const firstSignature = resultsSignature(results)

  for (let run = 2; run <= repeat; run += 1) {
    const nextResults = await evaluateCoverageMatrix(matrix, options)
    if (resultsSignature(nextResults) !== firstSignature) {
      driftRuns += 1
    }
    results = nextResults
  }

  const mismatches = results.filter((result) => !result.observeOnly && result.match === false)

  return {
    reportSchemaVersion: COVERAGE_PROBE_REPORT_SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    packageVersion: await readPackageVersion(repoRoot),
    gitSha: readGitSha(),
    matrixPath,
    matrixHash: hashStableJson(matrix),
    repeat,
    driftRuns,
    contexts: contexts.map((evalContext) => ({
      id: evalContext.id,
      cwd: evalContext.cwd,
      repoRoot: evalContext.repoRoot,
      resolvedConfigHash: resolvedConfigHash(evalContext),
      configProvenance: evalContext.configProvenance,
    })),
    summary: summarizeResults(results, filters),
    results,
    mismatches,
  }
}

export function formatCoverageProbeSummary(report: CoverageProbeReport): string {
  const lines = [
    'Coverage probe',
    `  cases: ${report.summary.total} (observe-only: ${report.summary.observeOnly})`,
    `  matched: ${report.summary.matched}`,
    `  mismatched: ${report.summary.mismatched}`,
    `  repeat: ${report.repeat} (drift runs: ${report.driftRuns})`,
    '  contexts:',
  ]

  for (const evalContext of report.contexts) {
    lines.push(
      `    ${evalContext.id}: cwd=${evalContext.cwd} configHash=${evalContext.resolvedConfigHash.slice(0, 12)}…`,
    )
  }

  if (report.mismatches.length > 0) {
    lines.push('  mismatches:')
    for (const mismatch of report.mismatches.slice(0, 15)) {
      lines.push(
        `    - [${mismatch.context}] ${mismatch.caseId}: expected=${JSON.stringify(mismatch.expectation)} actual=${mismatch.actual.verdict}/${mismatch.actual.reason}`,
      )
    }
    if (report.mismatches.length > 15) {
      lines.push(`    … and ${report.mismatches.length - 15} more`)
    }
  }

  if (report.summary.filteredEmpty) {
    lines.push('  warning: filter matched zero cases')
  }

  return lines.join('\n')
}

export function parseCoverageProbeCliArgs(argv: string[]): {
  repoRoot?: string
  matrixPath?: string
  contextIds?: CoverageContextId[]
  filters: string[]
  repeat: number
  strict: boolean
  outputDir?: string
  comparePath?: string
  json: boolean
} {
  let repoRoot: string | undefined
  let matrixPath: string | undefined
  let contextIds: CoverageContextId[] | undefined
  let filters: string[] = []
  let repeat = 1
  let strict = false
  let outputDir: string | undefined
  let comparePath: string | undefined
  let json = false

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--repo-root' && argv[i + 1]) {
      repoRoot = argv[++i]
    } else if (arg === '--matrix' && argv[i + 1]) {
      matrixPath = argv[++i]
    } else if (arg === '--context' && i + 1 < argv.length) {
      const rawContexts = argv[++i]
        .split(',')
        .map((value) => value.trim())
        .filter(Boolean)
      contextIds = assertKnownContextIds(rawContexts)
    } else if (arg === '--filter' && i + 1 < argv.length) {
      filters = argv[++i]
        .split(',')
        .map((value) => value.trim())
        .filter(Boolean)
      if (filters.length === 0) {
        throw new CoverageProbeCliError('--filter requires at least one tag, group id, or case id')
      }
    } else if (arg === '--repeat' && argv[i + 1]) {
      repeat = Number.parseInt(argv[++i], 10)
      if (!Number.isFinite(repeat) || repeat < 1) {
        throw new CoverageProbeCliError('--repeat must be a positive integer')
      }
    } else if (arg === '--output-dir' && argv[i + 1]) {
      outputDir = argv[++i]
    } else if (arg === '--compare' && argv[i + 1]) {
      comparePath = argv[++i]
    } else if (arg === '--strict') {
      strict = true
    } else if (arg === '--json') {
      json = true
    }
  }

  return { repoRoot, matrixPath, contextIds, filters, repeat, strict, outputDir, comparePath, json }
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  try {
    const parsed = parseCoverageProbeCliArgs(argv)
    const report = await runCoverageProbe({
      repoRoot: parsed.repoRoot,
      matrixPath: parsed.matrixPath,
      contextIds: parsed.contextIds,
      filters: parsed.filters,
      repeat: parsed.repeat,
      outputDir: parsed.outputDir,
      json: parsed.json,
    })

    if (parsed.json) {
      console.log(JSON.stringify(report, null, 2))
    } else {
      console.log(formatCoverageProbeSummary(report))
    }

    if (parsed.outputDir) {
      await mkdir(parsed.outputDir, { recursive: true })
      const stamp = report.generatedAt.replace(/[:.]/g, '-')
      const outputPath = path.join(parsed.outputDir, `run-${stamp}.json`)
      await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
      if (!parsed.json) {
        console.log(`\nWrote ${outputPath}`)
      }
    }

    if (parsed.comparePath) {
      const baselineRaw = JSON.parse(await readFile(path.resolve(parsed.comparePath), 'utf8')) as CoverageProbeReport
      const compareReport = compareCoverageReports(baselineRaw, report)
      if (!parsed.json) {
        console.log(`\n${formatCoverageCompareReport(compareReport)}`)
      }
      if (compareReport.configDrift.length > 0) {
        console.warn(
          `\nWARNING: config drift detected for ${compareReport.configDrift.length} context(s); compare may include classifier drift from config changes`,
        )
      }
    }

    if (report.driftRuns > 0 && !parsed.json) {
      console.warn(
        `\nWARNING: classifier drift detected in ${report.driftRuns}/${report.repeat} repeats`,
      )
    }

    if (report.summary.filteredEmpty) {
      console.warn('\nWARNING: --filter matched zero cases; check tag/group/case ids')
      return 2
    }

    if (parsed.strict && report.summary.mismatched > 0) {
      return 1
    }
    return 0
  } catch (error) {
    if (error instanceof CoverageProbeCliError || error instanceof CoverageMatrixSchemaError) {
      console.error(error.message)
      return 1
    }
    throw error
  }
}
