import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  type AdversarialProbeReport,
  generateProbeCases,
  probeCaseKey,
} from './adversarial-probe.js'
import { type CorpusCase, parseCorpusCases } from './types.js'

export interface RatchetCandidate {
  command: string
  core: string
  mutatorId: string
  sourceBatchId: string
  sourceCaseId: string
}

export interface RatchetPlan {
  corpusPath: string
  candidates: RatchetCandidate[]
  newCases: CorpusCase[]
  skippedDuplicates: number
}

export function candidatesFromPassedMutations(
  passed: Array<{ command: string; core: string; mutatorId: string }>,
  batchId: string,
): RatchetCandidate[] {
  return passed.map((entry, index) => ({
    command: entry.command,
    core: entry.core,
    mutatorId: entry.mutatorId,
    sourceBatchId: batchId,
    sourceCaseId: `${batchId}:${entry.mutatorId}:${entry.core}:${index}`,
  }))
}

/** Build must-ask corpus entries from ratchet candidates (add-only). */
export function buildRatchetCases(candidates: RatchetCandidate[]): CorpusCase[] {
  return candidates.map((candidate) => ({
    kind: 'shell' as const,
    category: 'must-ask' as const,
    command: candidate.command,
    verdict: 'deny_pending_approval' as const,
    provenance: {
      source: 'mutation' as const,
      sourceBatchId: candidate.sourceBatchId,
      sourceCaseId: candidate.sourceCaseId,
    },
  }))
}

export async function planCorpusRatchet(
  corpusPath: string,
  candidates: RatchetCandidate[],
): Promise<RatchetPlan> {
  const raw = JSON.parse(await readFile(corpusPath, 'utf8'))
  const existing = parseCorpusCases(raw)
  const existingCommands = new Set(existing.map((entry) => entry.command))
  const newCases = buildRatchetCases(candidates).filter((entry) => {
    if (existingCommands.has(entry.command)) {
      return false
    }
    existingCommands.add(entry.command)
    return true
  })

  return {
    corpusPath,
    candidates,
    newCases,
    skippedDuplicates: candidates.length - newCases.length,
  }
}

export async function applyCorpusRatchet(
  plan: RatchetPlan,
  options: { dryRun?: boolean } = {},
): Promise<{ appended: number; skippedDuplicates: number }> {
  if (plan.newCases.length === 0) {
    return { appended: 0, skippedDuplicates: plan.skippedDuplicates }
  }

  if (options.dryRun) {
    return { appended: plan.newCases.length, skippedDuplicates: plan.skippedDuplicates }
  }

  const raw = JSON.parse(await readFile(plan.corpusPath, 'utf8'))
  const existing = parseCorpusCases(raw)
  const merged = [...existing, ...plan.newCases]
  await writeFile(plan.corpusPath, `${JSON.stringify(merged, null, 2)}\n`, 'utf8')
  return { appended: plan.newCases.length, skippedDuplicates: plan.skippedDuplicates }
}

export function defaultCorpusPath(repoRoot: string): string {
  return path.join(repoRoot, 'corpus', 'shell-commands.json')
}

export function passedMutationsFromProbeReport(
  report: Pick<
    AdversarialProbeReport,
    'seed' | 'failures' | 'batchId' | 'passedCases' | 'maxCases'
  >,
  options: { maxCases?: number } = {},
): Array<{ command: string; core: string; mutatorId: string }> {
  if (Array.isArray(report.passedCases)) {
    return report.passedCases
  }

  // Legacy artifacts (pre passedCases): regenerate from seed — fragile when mutators change.
  const maxCases = options.maxCases ?? report.maxCases
  const cases = generateProbeCases(report.seed, maxCases)
  const failureKeys = new Set(report.failures.map((failure) => probeCaseKey(failure)))
  return cases
    .filter((entry) => !failureKeys.has(probeCaseKey(entry)))
    .map((entry) => ({
      command: entry.command,
      core: entry.core,
      mutatorId: entry.mutatorId,
    }))
}

export async function planRatchetFromProbeReport(
  report: AdversarialProbeReport,
  corpusPath: string,
  options: { maxCases?: number } = {},
): Promise<RatchetPlan> {
  const passed = passedMutationsFromProbeReport(report, options)
  const candidates = candidatesFromPassedMutations(passed, report.batchId)
  return planCorpusRatchet(corpusPath, candidates)
}

export function formatRatchetPlan(plan: RatchetPlan): string {
  const lines = [
    `Corpus ratchet plan (${plan.corpusPath})`,
    `  candidates: ${plan.candidates.length}`,
    `  new cases: ${plan.newCases.length}`,
    `  skipped duplicates: ${plan.skippedDuplicates}`,
  ]
  for (const entry of plan.newCases.slice(0, 10)) {
    lines.push(`  - [${entry.provenance?.sourceCaseId}] ${JSON.stringify(entry.command)}`)
  }
  if (plan.newCases.length > 10) {
    lines.push(`  ... ${plan.newCases.length - 10} more`)
  }
  return lines.join('\n')
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  const apply = argv.includes('--apply')
  const reportFlagIndex = argv.indexOf('--report')
  const reportPath =
    reportFlagIndex >= 0 && argv[reportFlagIndex + 1] ? argv[reportFlagIndex + 1] : undefined

  if (!reportPath) {
    console.error('Usage: corpus-ratchet --report <iteration.json> [--apply]')
    return 1
  }

  const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
  const report = JSON.parse(await readFile(reportPath, 'utf8')) as AdversarialProbeReport
  const plan = await planRatchetFromProbeReport(report, defaultCorpusPath(root))
  console.log(formatRatchetPlan(plan))

  const result = await applyCorpusRatchet(plan, { dryRun: !apply })
  console.log(
    apply
      ? `Applied ${result.appended} case(s) to corpus.`
      : `Dry-run only — would append ${result.appended} case(s). Pass --apply to write.`,
  )
  return 0
}
