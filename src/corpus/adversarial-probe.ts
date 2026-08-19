import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { evaluateCommandBatch, evaluateFpCommandBatch } from './evaluate.js'
import { BENIGN_PROBE_CORES } from './benign-probe-cores.js'
import {
  AUTO_LABEL_MUTATORS,
  CATASTROPHIC_CORES,
  generateMutatedCases,
  type MutatedCase,
} from './mutators.js'

const MUST_ASK_VERDICT = 'deny_pending_approval' as const

export function probeCaseKey(entry: { core: string; mutatorId: string; command: string }): string {
  return `${entry.core}\0${entry.mutatorId}\0${entry.command}`
}

export interface ProbePassedCase {
  core: string
  mutatorId: string
  command: string
}

export interface AdversarialProbeFailure {
  core: string
  mutatorId: string
  command: string
  expected: typeof MUST_ASK_VERDICT
  actual: string
  reason: string
}

export interface AdversarialProbeFpFailure {
  core: string
  mutatorId: string
  command: string
  actual: string
  reason: string
}

export interface AdversarialProbeReport {
  iteration: number
  generatedAt: string
  seed: number
  batchId: string
  sourceCommands: string[]
  selectedMutators: string[]
  maxCases?: number
  holdoutRatio: number
  totalCases: number
  fixSetSize: number
  holdoutSetSize: number
  fixSetFnRate: number
  firstPassFnRate: number
  /** null when no FP probe cases were evaluated. */
  firstPassFpRate: number | null
  fpProbeSize: number
  /** null when holdout set is empty, or fix set FN rate is 0 but holdout FN > 0. */
  holdoutFnRate: number | null
  /** holdoutFnRate / fixSetFnRate; 1.0 when both are 0. null when holdout empty. */
  holdoutFixFnRateRatio: number | null
  passedCases: ProbePassedCase[]
  failures: AdversarialProbeFailure[]
  fpFailures: AdversarialProbeFpFailure[]
  /** Populated by fix sessions / CI integration; empty when probe-only. */
  filesChanged: string[]
}

export interface AdversarialProbeOptions {
  seed?: number
  holdoutRatio?: number
  maxCases?: number
  outputDir?: string
  repoRoot?: string
  iteration?: number
}

/** Mulberry32 PRNG for reproducible shuffles. */
export function createSeededRandom(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state += 0x6d2b79f5
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export function shuffleWithSeed<T>(items: readonly T[], seed: number): T[] {
  const random = createSeededRandom(seed)
  const copy = [...items]
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1))
    ;[copy[i], copy[j]] = [copy[j], copy[i]]
  }
  return copy
}

export function splitFixHoldout<T>(
  items: readonly T[],
  seed: number,
  holdoutRatio = 0.2,
): { fix: T[]; holdout: T[] } {
  const shuffled = shuffleWithSeed(items, seed)
  const holdoutSize = Math.max(1, Math.floor(shuffled.length * holdoutRatio))
  if (shuffled.length <= 1) {
    return { fix: [...shuffled], holdout: [] }
  }
  return {
    fix: shuffled.slice(holdoutSize),
    holdout: shuffled.slice(0, holdoutSize),
  }
}

export function generateProbeCases(seed: number, maxCases?: number): MutatedCase[] {
  const all = generateMutatedCases(CATASTROPHIC_CORES, AUTO_LABEL_MUTATORS)
  const shuffled = shuffleWithSeed(all, seed)
  if (maxCases === undefined || maxCases >= shuffled.length) {
    return shuffled
  }
  return shuffled.slice(0, maxCases)
}

/** Benign probe cores × AUTO_LABEL mutators — FP over-stop probe (not for corpus auto-add). */
export function generateFpProbeCases(seed: number): MutatedCase[] {
  const all = generateMutatedCases([...BENIGN_PROBE_CORES], AUTO_LABEL_MUTATORS)
  return shuffleWithSeed(all, seed + 1000)
}

function fnRate(fnCount: number, total: number): number {
  return total === 0 ? 0 : fnCount / total
}

/** Ratio for overfitting detection; null when holdout unavailable or fix-perfect but holdout not. */
export function holdoutFixFnRateRatio(
  fixSetFnRate: number,
  holdoutFnRate: number | null,
): number | null {
  if (holdoutFnRate === null) {
    return null
  }
  if (fixSetFnRate === 0) {
    return holdoutFnRate === 0 ? 1 : null
  }
  return holdoutFnRate / fixSetFnRate
}

function toBatchId(date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}-${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}`
}

export async function runAdversarialProbe(
  options: AdversarialProbeOptions = {},
): Promise<AdversarialProbeReport> {
  const seed = options.seed ?? 42
  const holdoutRatio = options.holdoutRatio ?? 0.2
  const cases = generateProbeCases(seed, options.maxCases)
  const { fix, holdout } = splitFixHoldout(cases, seed + 1, holdoutRatio)

  const toInput = (c: MutatedCase) => ({
    command: c.command,
    expected: MUST_ASK_VERDICT,
    core: c.core,
    mutatorId: c.mutatorId,
  })

  const allResults = await evaluateCommandBatch(cases.map(toInput), options.repoRoot)

  const resultByKey = new Map(
    allResults.map((result) => [
      probeCaseKey({
        core: result.core ?? '',
        mutatorId: result.mutatorId ?? '',
        command: result.command,
      }),
      result,
    ]),
  )
  const holdoutResults = holdout
    .map((c) => resultByKey.get(probeCaseKey(c)))
    .filter((r): r is NonNullable<typeof r> => r !== undefined)

  const fixResults = fix
    .map((c) => resultByKey.get(probeCaseKey(c)))
    .filter((r): r is NonNullable<typeof r> => r !== undefined)

  const passedCases: ProbePassedCase[] = allResults
    .filter((r) => !r.isFn)
    .map((r) => ({
      core: r.core ?? '',
      mutatorId: r.mutatorId ?? '',
      command: r.command,
    }))

  const failures: AdversarialProbeFailure[] = allResults
    .filter((r) => r.isFn)
    .map((r) => ({
      core: r.core ?? '',
      mutatorId: r.mutatorId ?? '',
      command: r.command,
      expected: MUST_ASK_VERDICT,
      actual: r.actual,
      reason: r.reason,
    }))

  const fpCases = generateFpProbeCases(seed)
  const fpResults = await evaluateFpCommandBatch(
    fpCases.map((c) => ({ command: c.command, core: c.core, mutatorId: c.mutatorId })),
    options.repoRoot,
  )
  const fpFailures: AdversarialProbeFpFailure[] = fpResults
    .filter((r) => r.isFp)
    .map((r) => ({
      core: r.core,
      mutatorId: r.mutatorId,
      command: r.command,
      actual: r.actual,
      reason: r.reason,
    }))

  const fixSetFnRate = fnRate(fixResults.filter((r) => r.isFn).length, fixResults.length)
  const holdoutFnRate =
    holdoutResults.length === 0
      ? null
      : fnRate(holdoutResults.filter((r) => r.isFn).length, holdoutResults.length)

  const report: AdversarialProbeReport = {
    iteration: options.iteration ?? 1,
    generatedAt: new Date().toISOString(),
    seed,
    batchId: toBatchId(),
    sourceCommands: [...CATASTROPHIC_CORES],
    selectedMutators: AUTO_LABEL_MUTATORS.map((m) => m.id),
    ...(options.maxCases !== undefined ? { maxCases: options.maxCases } : {}),
    holdoutRatio,
    totalCases: cases.length,
    fixSetSize: fix.length,
    holdoutSetSize: holdout.length,
    fixSetFnRate,
    firstPassFnRate: fnRate(allResults.filter((r) => r.isFn).length, allResults.length),
    firstPassFpRate:
      fpResults.length === 0
        ? null
        : fnRate(fpResults.filter((r) => r.isFp).length, fpResults.length),
    fpProbeSize: fpResults.length,
    holdoutFnRate,
    holdoutFixFnRateRatio: holdoutFixFnRateRatio(fixSetFnRate, holdoutFnRate),
    passedCases,
    failures,
    fpFailures,
    filesChanged: [],
  }

  if (options.outputDir) {
    await mkdir(options.outputDir, { recursive: true })
    const filePath = path.join(options.outputDir, `iteration-${report.batchId}.json`)
    await writeFile(filePath, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
  }

  return report
}

export function defaultProbeOutputDir(): string {
  const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
  return path.join(root, 'artifacts', 'quality-loop')
}

export function formatProbeSummary(report: AdversarialProbeReport): string {
  const lines = [
    'Adversarial probe (must-ask mutations)',
    `  batchId: ${report.batchId}`,
    `  seed: ${report.seed}`,
    `  cases: fix=${report.fixSetSize} holdout=${report.holdoutSetSize}`,
    `  fixSetFnRate: ${(report.fixSetFnRate * 100).toFixed(1)}%`,
    `  firstPassFnRate: ${(report.firstPassFnRate * 100).toFixed(1)}%`,
    `  firstPassFpRate: ${report.firstPassFpRate === null ? 'n/a' : `${(report.firstPassFpRate * 100).toFixed(1)}%`}`,
    `  holdoutFnRate: ${report.holdoutFnRate === null ? 'n/a' : `${(report.holdoutFnRate * 100).toFixed(1)}%`}`,
    `  holdoutFixFnRateRatio: ${report.holdoutFixFnRateRatio === null ? 'n/a' : report.holdoutFixFnRateRatio.toFixed(2)}`,
    `  failures: ${report.failures.length}`,
    `  fpFailures: ${report.fpFailures.length}`,
  ]
  for (const failure of report.failures.slice(0, 10)) {
    lines.push(
      `  - [${failure.mutatorId}] ${JSON.stringify(failure.command)} expected=${failure.expected} actual=${failure.actual} (${failure.reason})`,
    )
  }
  return lines.join('\n')
}

export function parseProbeCliArgs(argv: string[]): {
  seed: number
  holdoutRatio: number
  maxCases?: number
  strict: boolean
  outputDir: string
} {
  let seed = 42
  let holdoutRatio = 0.2
  let maxCases: number | undefined
  let strict = false
  let outputDir = defaultProbeOutputDir()

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--seed' && argv[i + 1]) {
      seed = Number.parseInt(argv[++i], 10)
    } else if (arg === '--holdout-ratio' && argv[i + 1]) {
      holdoutRatio = Number.parseFloat(argv[++i])
    } else if (arg === '--max-cases' && argv[i + 1]) {
      maxCases = Number.parseInt(argv[++i], 10)
    } else if (arg === '--output-dir' && argv[i + 1]) {
      outputDir = argv[++i]
    } else if (arg === '--strict') {
      strict = true
    }
  }

  return { seed, holdoutRatio, maxCases, strict, outputDir }
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  const { seed, holdoutRatio, maxCases, strict, outputDir } = parseProbeCliArgs(argv)
  const report = await runAdversarialProbe({ seed, holdoutRatio, maxCases, outputDir })
  console.log(formatProbeSummary(report))
  console.log(`\nWrote ${path.join(outputDir, `iteration-${report.batchId}.json`)}`)

  if (strict && report.failures.length > 0) {
    return 1
  }
  return 0
}
