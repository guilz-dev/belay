import path from 'node:path'
import { fileURLToPath } from 'node:url'

import type { AdapterName } from '../adapters/layouts/index.js'
import { loadConfigFile } from '../config-io.js'
import {
  MAX_BENIGN_BLOCK_RATE,
  MIN_REVIEWED_BENIGN_EVENTS,
  MIN_REVIEWED_SESSIONS,
} from '../core/audit-metrics.js'
import type { AuditRecord } from '../core/audit-types.js'
import type { BelayConfigV3 } from '../core/config.js'
import { runCorpusEvaluation } from '../corpus/evaluate.js'
import { passesHardGates } from '../corpus/gates.js'
import type { CorpusCategory, CorpusProvenanceCounts } from '../corpus/types.js'
import { harvestReportFromRecords } from './harvest.js'
import { evaluateMetricsSnapshot, type MetricsReport } from './metrics.js'

export const QUALITY_REPORT_SCHEMA_VERSION = 1

export interface QualityReport {
  schemaVersion: typeof QUALITY_REPORT_SCHEMA_VERSION
  ok: boolean
  trafficReadyForEnforce: boolean
  readyForEnforce: boolean
  failedGates: string[]
  corpus: {
    path: string
    passesHardGates: boolean
    totalCases: number
    categoryCounts: Record<CorpusCategory, number>
    provenanceCounts: CorpusProvenanceCounts
    mustAskMisses: number
    provablyBenignBlocks: number
    acceptedBenignMismatches: number
    accuracy: number
  }
  audit: {
    logPath: string
    gateEvents: number
    classifierWouldBlockRate: number
    availabilityAsks: number
    availabilityWatermarkStatus: MetricsReport['currentCohort']['availabilityWatermark']['status']
    stickyAvailabilityAsks: number
    reviewedBenignEvents: number
    reviewedBenignBlocked: number
    benignBlockRate: number
    distinctSessions: number
    readyForEnforce: boolean
    repeatedFingerprintPatterns: number
  }
  harvest: {
    scope: 'shell'
    benignCandidates: number
    availabilityQueue: number
  }
  notes: string[]
}

export interface QualityOptions {
  targetDir?: string
  adapter?: AdapterName
  corpusDir?: string
  json?: boolean
}

export interface QualityEvaluationSnapshot {
  report: QualityReport
  config: BelayConfigV3
  metrics: MetricsReport
  auditRecords: AuditRecord[]
}

export function resolveDefaultQualityCorpusDir(moduleUrl: string | URL = import.meta.url): string {
  return path.resolve(fileURLToPath(new URL('../../corpus/', moduleUrl)))
}

export async function evaluateQualitySnapshot(
  options: QualityOptions = {},
  evaluatedConfig?: BelayConfigV3,
): Promise<QualityEvaluationSnapshot> {
  const repoRoot = path.resolve(options.targetDir ?? process.cwd())
  const config = evaluatedConfig ?? (await loadConfigFile(repoRoot, options.adapter))
  const corpusDir = options.corpusDir
    ? path.resolve(repoRoot, options.corpusDir)
    : resolveDefaultQualityCorpusDir()

  const corpusMetrics = await runCorpusEvaluation(corpusDir)
  const hardGatesOk = corpusMetrics.total > 0 && passesHardGates(corpusMetrics.gates)
  const metricsSnapshot = await evaluateMetricsSnapshot(
    { targetDir: repoRoot, adapter: options.adapter },
    config,
  )
  const { auditRecords, report: metrics } = metricsSnapshot
  const harvest = harvestReportFromRecords(auditRecords)
  const cohort = metrics.currentCohort
  const traffic = cohort.reviewedTraffic
  const trafficReadyForEnforce = traffic.ready
  const failedGates: string[] = []

  if (corpusMetrics.total === 0) {
    failedGates.push('Corpus cases: 0 (required: at least 1).')
  }
  if (corpusMetrics.gates.mustAsk.mismatches !== 0) {
    failedGates.push(
      `Corpus MUST-ASK misses: ${corpusMetrics.gates.mustAsk.mismatches} (required: 0).`,
    )
  }
  if (corpusMetrics.gates.provablyBenign.mismatches !== 0) {
    failedGates.push(
      `Corpus provably-benign blocks: ${corpusMetrics.gates.provablyBenign.mismatches} (required: 0).`,
    )
  }
  if (!cohort.identity) {
    failedGates.push('Active audit cohort is unavailable.')
  }
  if (!cohort.reviewEvidencePresent) {
    failedGates.push('Review evidence is missing.')
  }
  if (cohort.identity && cohort.gateEvents === 0) {
    failedGates.push(
      'No gate events for the active runtime/config cohort — run normal agent work, then re-check quality.',
    )
  }
  if (traffic.reviewedBenignEvents < MIN_REVIEWED_BENIGN_EVENTS) {
    failedGates.push(
      `Reviewed provably-benign events: ${traffic.reviewedBenignEvents} (required: at least ${MIN_REVIEWED_BENIGN_EVENTS}).`,
    )
  }
  if (traffic.distinctSessions < MIN_REVIEWED_SESSIONS) {
    failedGates.push(
      `Distinct valid reviewed sessions: ${traffic.distinctSessions} (required: at least ${MIN_REVIEWED_SESSIONS}).`,
    )
  }
  if (traffic.reviewedBenignEvents > 0 && traffic.benignBlockRate >= MAX_BENIGN_BLOCK_RATE) {
    failedGates.push(
      `Reviewed benign block rate: ${(traffic.benignBlockRate * 100).toFixed(2)}% (required: below ${(MAX_BENIGN_BLOCK_RATE * 100).toFixed(2)}%).`,
    )
  }
  if (traffic.availabilityAsks !== 0) {
    failedGates.push(`Availability-caused asks: ${traffic.availabilityAsks} (required: 0).`)
  }
  if (
    cohort.availabilityWatermark.status !== 'not-evaluated' &&
    cohort.availabilityWatermark.status !== 'current'
  ) {
    failedGates.push(
      `Persistent availability watermark: ${cohort.availabilityWatermark.status} (required: current).`,
    )
  }

  const readyForEnforce = hardGatesOk && trafficReadyForEnforce

  const notes: string[] = [
    'Overall readiness requires corpus hard gates and reviewed active-cohort traffic.',
    'Recursive quality loop: corpus hard gates remain the FN/FP safety boundary.',
    'Harvest reviews qualify traffic evidence but never grant runtime permission; approvals are not ground truth.',
    'Simulate (`belay simulate`) is triage only; it does not replace `pnpm corpus`.',
  ]

  if (!hardGatesOk) {
    notes.push(
      'Corpus hard gates failed — fix must-ask misses and provably-benign blocks before tuning friction.',
    )
  }
  if (traffic.availabilityAsks > 0) {
    notes.push(
      `${traffic.availabilityAsks} active-cohort availability-caused ask(s) — tune judge/cwd infrastructure before enforce promotion.`,
    )
  }
  if (harvest.availabilityQueue.length > 0) {
    notes.push(
      `${harvest.availabilityQueue.length} shell pattern(s) in the availability queue — do not harvest into corpus.`,
    )
  }

  if (failedGates.length > 0) {
    notes.push(`First failed gate: ${failedGates[0]}`)
  }

  const report: QualityReport = {
    schemaVersion: QUALITY_REPORT_SCHEMA_VERSION,
    ok: readyForEnforce,
    trafficReadyForEnforce,
    readyForEnforce,
    failedGates,
    corpus: {
      path: path.relative(repoRoot, corpusDir) || corpusDir,
      passesHardGates: hardGatesOk,
      totalCases: corpusMetrics.total,
      categoryCounts: corpusMetrics.categoryCounts,
      provenanceCounts: corpusMetrics.provenanceCounts,
      mustAskMisses: corpusMetrics.gates.mustAsk.mismatches,
      provablyBenignBlocks: corpusMetrics.gates.provablyBenign.mismatches,
      acceptedBenignMismatches: corpusMetrics.gates.acceptedBenign.mismatches,
      accuracy: corpusMetrics.accuracy,
    },
    audit: {
      logPath: config.audit.logPath,
      gateEvents: cohort.gateEvents,
      classifierWouldBlockRate: cohort.classifierWouldBlockRate,
      availabilityAsks: traffic.availabilityAsks,
      availabilityWatermarkStatus: cohort.availabilityWatermark.status,
      stickyAvailabilityAsks: cohort.availabilityWatermark.availabilityAsks,
      reviewedBenignEvents: traffic.reviewedBenignEvents,
      reviewedBenignBlocked: traffic.reviewedBenignBlocked,
      benignBlockRate: traffic.benignBlockRate,
      distinctSessions: traffic.distinctSessions,
      readyForEnforce: trafficReadyForEnforce,
      repeatedFingerprintPatterns: metrics.repeatedFingerprintAsks.length,
    },
    harvest: {
      scope: 'shell',
      benignCandidates: harvest.candidates.length,
      availabilityQueue: harvest.availabilityQueue.length,
    },
    notes,
  }

  return { report, config, metrics, auditRecords }
}

export async function qualityCheck(options: QualityOptions = {}): Promise<QualityReport> {
  return (await evaluateQualitySnapshot(options)).report
}

export function formatQualityReport(report: QualityReport): string {
  const lines = [
    'belay quality — recursive quality loop status',
    `Schema: v${report.schemaVersion}`,
    `Overall: ${report.ok ? 'OK' : 'ATTENTION NEEDED'}`,
    `Ready for enforce: ${report.readyForEnforce ? 'yes' : 'no'}`,
    '',
    'Corpus hard gates:',
    `  path: ${report.corpus.path}`,
    `  passes: ${report.corpus.passesHardGates ? 'yes' : 'no'}`,
    `  total cases: ${report.corpus.totalCases}`,
    `  categories: must-ask=${report.corpus.categoryCounts['must-ask']} provably-benign=${report.corpus.categoryCounts['provably-benign']} accepted-benign=${report.corpus.categoryCounts['accepted-benign']}`,
    `  provenance: manual=${report.corpus.provenanceCounts.manual} mutation=${report.corpus.provenanceCounts.mutation} harvest=${report.corpus.provenanceCounts.harvest} redteam=${report.corpus.provenanceCounts.redteam} unspecified=${report.corpus.provenanceCounts.unspecified}`,
    `  must-ask misses: ${report.corpus.mustAskMisses}`,
    `  provably-benign blocks: ${report.corpus.provablyBenignBlocks}`,
    `  accepted-benign mismatches (soft): ${report.corpus.acceptedBenignMismatches}`,
    `  accuracy: ${(report.corpus.accuracy * 100).toFixed(1)}%`,
    '',
    'Audit metrics:',
    `  log: ${report.audit.logPath}`,
    `  gate events: ${report.audit.gateEvents}`,
    `  classifier would-block rate: ${(report.audit.classifierWouldBlockRate * 100).toFixed(1)}%`,
    `  reviewed benign events: ${report.audit.reviewedBenignEvents}`,
    `  reviewed benign blocked: ${report.audit.reviewedBenignBlocked} (${(report.audit.benignBlockRate * 100).toFixed(2)}%)`,
    `  distinct valid sessions: ${report.audit.distinctSessions}`,
    `  availability asks: ${report.audit.availabilityAsks}`,
    `  persistent availability watermark: ${report.audit.availabilityWatermarkStatus} (${report.audit.stickyAvailabilityAsks} ask(s))`,
    `  traffic ready for enforce: ${report.trafficReadyForEnforce ? 'yes' : 'no'}`,
    `  repeated fingerprint patterns: ${report.audit.repeatedFingerprintPatterns}`,
    '',
    'Harvest (shell only):',
    `  benign candidates: ${report.harvest.benignCandidates}`,
    `  availability queue: ${report.harvest.availabilityQueue}`,
  ]

  if (report.failedGates.length > 0) {
    lines.push('', 'Failed readiness gates:')
    for (const failure of report.failedGates) {
      lines.push(`- ${failure}`)
    }
  }

  lines.push('', 'Notes:')

  for (const note of report.notes) {
    lines.push(`- ${note}`)
  }

  return lines.join('\n')
}
