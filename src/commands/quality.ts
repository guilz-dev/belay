import path from 'node:path'

import { loadConfigFile } from '../config-io.js'
import { runCorpusEvaluation } from '../corpus/evaluate.js'
import { passesHardGates } from '../corpus/gates.js'
import { harvestListProject } from './harvest.js'
import { metricsProject } from './metrics.js'

export const QUALITY_REPORT_SCHEMA_VERSION = 1

export interface QualityReport {
  schemaVersion: typeof QUALITY_REPORT_SCHEMA_VERSION
  ok: boolean
  corpus: {
    path: string
    passesHardGates: boolean
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
  corpusDir?: string
  json?: boolean
}

export async function qualityCheck(options: QualityOptions = {}): Promise<QualityReport> {
  const repoRoot = path.resolve(options.targetDir ?? process.cwd())
  const config = await loadConfigFile(repoRoot)
  const corpusDir = path.resolve(repoRoot, options.corpusDir ?? 'corpus')

  const corpusMetrics = await runCorpusEvaluation(corpusDir)
  const hardGatesOk = passesHardGates(corpusMetrics.gates)
  const metrics = await metricsProject({ targetDir: repoRoot })
  const harvest = await harvestListProject({ targetDir: repoRoot })

  const notes: string[] = [
    'Recursive quality loop: corpus hard gates are the FN/FP safety boundary.',
    'Harvest candidates and audit metrics inform review — approvals are not ground truth.',
    'Simulate (`belay simulate`) is triage only; it does not replace `pnpm corpus`.',
  ]

  if (!hardGatesOk) {
    notes.push(
      'Corpus hard gates failed — fix must-ask misses and provably-benign blocks before tuning friction.',
    )
  }
  if (metrics.availabilityAsks.total > 0) {
    notes.push(
      `${metrics.availabilityAsks.total} availability-caused ask(s) — tune judge/cwd infrastructure before corpus promotion.`,
    )
  }
  if (harvest.availabilityQueue.length > 0) {
    notes.push(
      `${harvest.availabilityQueue.length} shell pattern(s) in the availability queue — do not harvest into corpus.`,
    )
  }

  const ok = hardGatesOk

  return {
    schemaVersion: QUALITY_REPORT_SCHEMA_VERSION,
    ok,
    corpus: {
      path: path.relative(repoRoot, corpusDir) || corpusDir,
      passesHardGates: hardGatesOk,
      mustAskMisses: corpusMetrics.gates.mustAsk.mismatches,
      provablyBenignBlocks: corpusMetrics.gates.provablyBenign.mismatches,
      acceptedBenignMismatches: corpusMetrics.gates.acceptedBenign.mismatches,
      accuracy: corpusMetrics.accuracy,
    },
    audit: {
      logPath: config.audit.logPath,
      gateEvents: metrics.gateEvents,
      classifierWouldBlockRate: metrics.classifierWouldBlockRate,
      availabilityAsks: metrics.availabilityAsks.total,
      readyForEnforce: metrics.dogfood.readyForEnforce,
      repeatedFingerprintPatterns: metrics.repeatedFingerprintAsks.length,
    },
    harvest: {
      scope: 'shell',
      benignCandidates: harvest.candidates.length,
      availabilityQueue: harvest.availabilityQueue.length,
    },
    notes,
  }
}

export function formatQualityReport(report: QualityReport): string {
  const lines = [
    'belay quality — recursive quality loop status',
    `Schema: v${report.schemaVersion}`,
    `Overall: ${report.ok ? 'OK' : 'ATTENTION NEEDED'}`,
    '',
    'Corpus hard gates:',
    `  path: ${report.corpus.path}`,
    `  passes: ${report.corpus.passesHardGates ? 'yes' : 'no'}`,
    `  must-ask misses: ${report.corpus.mustAskMisses}`,
    `  provably-benign blocks: ${report.corpus.provablyBenignBlocks}`,
    `  accepted-benign mismatches (soft): ${report.corpus.acceptedBenignMismatches}`,
    `  accuracy: ${(report.corpus.accuracy * 100).toFixed(1)}%`,
    '',
    'Audit metrics:',
    `  log: ${report.audit.logPath}`,
    `  gate events: ${report.audit.gateEvents}`,
    `  classifier would-block rate: ${(report.audit.classifierWouldBlockRate * 100).toFixed(1)}%`,
    `  availability asks: ${report.audit.availabilityAsks}`,
    `  ready for enforce: ${report.audit.readyForEnforce ? 'yes' : 'no'}`,
    `  repeated fingerprint patterns: ${report.audit.repeatedFingerprintPatterns}`,
    '',
    'Harvest (shell only):',
    `  benign candidates: ${report.harvest.benignCandidates}`,
    `  availability queue: ${report.harvest.availabilityQueue}`,
    '',
    'Notes:',
  ]

  for (const note of report.notes) {
    lines.push(`- ${note}`)
  }

  return lines.join('\n')
}
