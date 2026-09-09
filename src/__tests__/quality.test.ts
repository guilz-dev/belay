import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

import { afterEach, describe, expect, it } from 'vitest'

import {
  formatQualityReport,
  qualityCheck,
  resolveDefaultQualityCorpusDir,
} from '../commands/quality.js'
import { loadConfigFile } from '../config-io.js'
import { appendAuditRecord } from '../core/audit-serialize.js'
import { DEFAULT_REDACTION_V3 } from '../core/config.js'
import { initProject } from '../installer.js'
import { resolveActiveAuditCohort } from '../runtime-provenance.js'

const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

const REVIEWED_FINGERPRINT = createHash('sha256').update('quality-reviewed-command').digest('hex')
const SESSION_IDS = ['1111111111111111', '2222222222222222', '3333333333333333']

async function seedReviewedTraffic(repoRoot: string, count = 150): Promise<void> {
  await initProject({ targetDir: repoRoot, dogfood: true })
  const config = await loadConfigFile(repoRoot)
  const cohort = await resolveActiveAuditCohort(repoRoot, config)
  expect(cohort).not.toBeNull()
  if (!cohort) {
    throw new Error('fixture active cohort unavailable')
  }
  const auditPath = path.join(repoRoot, config.audit.logPath)
  await mkdir(path.dirname(auditPath), { recursive: true })
  const records = Array.from({ length: count }, (_, index) => ({
    timestamp: new Date(1_780_000_000_000 + index).toISOString(),
    event: 'beforeShellExecution',
    kind: 'shell',
    verdict: 'allow',
    reason: 'read_only',
    wouldBlock: false,
    mode: 'audit',
    fingerprint: REVIEWED_FINGERPRINT,
    sessionCorrelationId: SESSION_IDS[index % SESSION_IDS.length],
    ...cohort,
  }))
  const retainedRecords = records.slice(0, -1)
  await writeFile(
    auditPath,
    retainedRecords.length > 0
      ? `${retainedRecords.map((record) => JSON.stringify(record)).join('\n')}\n`
      : '',
  )
  const finalRecord = records.at(-1)
  if (finalRecord) {
    await appendAuditRecord(auditPath, finalRecord, DEFAULT_REDACTION_V3)
  }
  await writeFile(
    path.join(path.dirname(auditPath), 'harvest-reviews.json'),
    `${JSON.stringify({
      version: 1,
      reviews: [
        {
          fingerprint: REVIEWED_FINGERPRINT,
          kind: 'shell',
          boundaryProfile: cohort.boundaryProfile,
          outcome: 'provably-benign',
          reviewedAt: '2026-09-08T00:00:00.000Z',
        },
      ],
    })}\n`,
  )
}

async function writeCorpus(repoRoot: string, cases: Record<string, unknown>[]): Promise<string> {
  const corpusDir = path.join(repoRoot, 'test-corpus')
  await mkdir(corpusDir, { recursive: true })
  await writeFile(path.join(corpusDir, 'shell-commands.json'), `${JSON.stringify(cases)}\n`)
  return corpusDir
}

const passingCorpus = [
  {
    kind: 'shell',
    category: 'provably-benign',
    command: 'git status',
    verdict: 'allow',
    reason: 'read_only',
  },
  {
    kind: 'shell',
    category: 'must-ask',
    command: 'git push origin main',
    verdict: 'deny_pending_approval',
    reason: 'external_effect',
  },
]

describe('quality loop', () => {
  it('resolves the packaged corpus identically from source and built command locations', () => {
    const packageRoot = path.resolve(import.meta.dirname, '../..')
    const sourceModuleUrl = pathToFileURL(
      path.join(packageRoot, 'src', 'commands', 'quality.ts'),
    ).href
    const builtModuleUrl = pathToFileURL(
      path.join(packageRoot, 'dist', 'commands', 'quality.js'),
    ).href

    expect(resolveDefaultQualityCorpusDir(sourceModuleUrl)).toBe(path.join(packageRoot, 'corpus'))
    expect(resolveDefaultQualityCorpusDir(builtModuleUrl)).toBe(path.join(packageRoot, 'corpus'))
  })

  it('includes the canonical corpus in the published package files', async () => {
    const packageRoot = path.resolve(import.meta.dirname, '../..')
    const packageJson = JSON.parse(
      await readFile(path.join(packageRoot, 'package.json'), 'utf8'),
    ) as { files?: string[] }

    expect(packageJson.files).toContain('corpus')
  })

  it('does not use inert override lists as harvest evidence', async () => {
    const repoRoot = path.resolve(import.meta.dirname, '../..')
    const sources = await Promise.all(
      ['src/core/harvest.ts', 'src/commands/harvest.ts', 'src/commands/quality.ts'].map(
        (relativePath) => readFile(path.join(repoRoot, relativePath), 'utf8'),
      ),
    )
    const combined = sources.join('\n')

    expect(combined).not.toContain('overrides_allow')
    expect(combined).not.toContain('allowPatterns')
    expect(combined).not.toContain('config.overrides.allow')
  })

  it('does not recommend command allowlists in user-facing guidance (ADR-005)', async () => {
    const repoRoot = path.resolve(import.meta.dirname, '../..')
    const guidancePaths = [
      'README.md',
      'CONTRIBUTING.md',
      'SECURITY.md',
      'docs/CONCEPT.md',
      'docs/CONCEPT.ja.md',
      'docs/CONTEXT.md',
      'docs/config-schema.md',
      'skills/belay/SKILL.md',
      '.cursor/skills/belay/SKILL.md',
      'docs/README.ja.md',
    ]
    const combined = (
      await Promise.all(
        guidancePaths.map((relativePath) => readFile(path.join(repoRoot, relativePath), 'utf8')),
      )
    ).join('\n')

    const prohibitionContext =
      /forbidden|Do not use|deprecated and ignored|ignored by shell|ADR-005|product-incompatible|must not appear|remain parse-compatible|使用禁止|リストに足す/i
    const recommendationLines = combined
      .split('\n')
      .filter((line) => !prohibitionContext.test(line))
      .filter(
        (line) =>
          /(?:add|append|put|set).*(?:overrides\.(?:allow|external)|allowlist|whitelist)/i.test(
            line,
          ) ||
          /(?:overrides\.(?:allow|external)).*(?:whitelist|allowlist|追加|通す)/i.test(line) ||
          /(?:standing allow|command list).*(?:fix|remediation|workaround|通)/i.test(line),
      )

    expect(recommendationLines).toEqual([])
    expect(combined).not.toMatch(/config set overrides\.(?:allow|external)/i)
  })

  it('reports corpus hard gate status for the belay repo', async () => {
    const report = await qualityCheck({ targetDir: process.cwd() })
    expect(report.schemaVersion).toBe(1)
    expect(report.corpus.passesHardGates).toBe(true)
    expect(report.corpus.totalCases).toBeGreaterThan(0)
    expect(report.corpus.provenanceCounts.unspecified).toBeGreaterThanOrEqual(0)
    expect(report.corpus.mustAskMisses).toBe(0)
    expect(report.corpus.provablyBenignBlocks).toBe(0)
    expect(report.harvest.scope).toBe('shell')
    expect(report.notes.some((note) => note.includes('hard gates'))).toBe(true)
    expect(report.trafficReadyForEnforce).toBe(false)
    expect(report.readyForEnforce).toBe(false)
    expect(report.ok).toBe(report.readyForEnforce)
  }, 60_000)

  it('uses the canonical packaged corpus when checking a different target repository', async () => {
    const repoRoot = await mkdtemp(path.join(os.tmpdir(), 'belay-quality-cross-repo-'))
    tempDirs.push(repoRoot)
    await seedReviewedTraffic(repoRoot)

    const report = await qualityCheck({ targetDir: repoRoot })

    expect(report.corpus.totalCases).toBeGreaterThan(0)
    expect(report.corpus.passesHardGates).toBe(true)
    expect(report.trafficReadyForEnforce).toBe(true)
    expect(report.readyForEnforce).toBe(true)
  }, 60_000)

  it('fails corpus hard gates for an explicitly empty corpus', async () => {
    const repoRoot = await mkdtemp(path.join(os.tmpdir(), 'belay-quality-empty-corpus-'))
    tempDirs.push(repoRoot)
    await seedReviewedTraffic(repoRoot)
    const corpusDir = await writeCorpus(repoRoot, [])

    const report = await qualityCheck({ targetDir: repoRoot, corpusDir })

    expect(report.corpus.totalCases).toBe(0)
    expect(report.corpus.passesHardGates).toBe(false)
    expect(report.trafficReadyForEnforce).toBe(true)
    expect(report.readyForEnforce).toBe(false)
    expect(report.failedGates).toContain('Corpus cases: 0 (required: at least 1).')
  })

  it('withholds combined readiness when reviewed traffic passes but either corpus hard gate fails', async () => {
    const repoRoot = await mkdtemp(path.join(os.tmpdir(), 'belay-quality-corpus-gates-'))
    tempDirs.push(repoRoot)
    await seedReviewedTraffic(repoRoot)
    const corpusDir = await writeCorpus(repoRoot, [
      {
        kind: 'shell',
        category: 'must-ask',
        command: 'git status',
        verdict: 'deny_pending_approval',
      },
      {
        kind: 'shell',
        category: 'provably-benign',
        command: 'git push origin main',
        verdict: 'allow',
      },
    ])

    const report = await qualityCheck({ targetDir: repoRoot, corpusDir })
    const formatted = formatQualityReport(report)

    expect(report.trafficReadyForEnforce).toBe(true)
    expect(report.corpus.mustAskMisses).toBe(1)
    expect(report.corpus.provablyBenignBlocks).toBe(1)
    expect(report.readyForEnforce).toBe(false)
    expect(report.ok).toBe(false)
    expect(report.failedGates).toEqual([
      'Corpus MUST-ASK misses: 1 (required: 0).',
      'Corpus provably-benign blocks: 1 (required: 0).',
    ])
    expect(formatted.indexOf(report.failedGates[0])).toBeLessThan(
      formatted.indexOf(report.failedGates[1]),
    )
  })

  it('reports combined readiness only when reviewed traffic and both corpus hard gates pass', async () => {
    const repoRoot = await mkdtemp(path.join(os.tmpdir(), 'belay-quality-combined-ready-'))
    tempDirs.push(repoRoot)
    await seedReviewedTraffic(repoRoot)
    const corpusDir = await writeCorpus(repoRoot, passingCorpus)

    const report = await qualityCheck({ targetDir: repoRoot, corpusDir })

    expect(report.audit.reviewedBenignEvents).toBe(150)
    expect(report.audit.reviewedBenignBlocked).toBe(0)
    expect(report.audit.benignBlockRate).toBe(0)
    expect(report.audit.distinctSessions).toBe(3)
    expect(report.audit.availabilityAsks).toBe(0)
    expect(report.trafficReadyForEnforce).toBe(true)
    expect(report.readyForEnforce).toBe(true)
    expect(report.failedGates).toEqual([])
    expect(report.ok).toBe(true)
  })

  it('seeds a missing watermark from retained availability evidence before rotation', async () => {
    const repoRoot = await mkdtemp(path.join(os.tmpdir(), 'belay-quality-sticky-availability-'))
    tempDirs.push(repoRoot)
    await initProject({ targetDir: repoRoot, dogfood: true })
    const config = await loadConfigFile(repoRoot)
    const cohort = await resolveActiveAuditCohort(repoRoot, config)
    expect(cohort).not.toBeNull()
    if (!cohort) {
      throw new Error('fixture active cohort unavailable')
    }
    const auditPath = path.join(repoRoot, config.audit.logPath)
    await writeFile(
      path.join(path.dirname(auditPath), 'harvest-reviews.json'),
      `${JSON.stringify({
        version: 1,
        reviews: [
          {
            fingerprint: REVIEWED_FINGERPRINT,
            kind: 'shell',
            boundaryProfile: cohort.boundaryProfile,
            outcome: 'provably-benign',
            reviewedAt: '2026-09-08T00:00:00.000Z',
          },
        ],
      })}\n`,
    )
    const tinyRetention = { maxBytes: 1, maxFiles: 1 }
    await appendAuditRecord(
      auditPath,
      {
        timestamp: '2026-09-08T02:00:00.000Z',
        event: 'beforeShellExecution',
        kind: 'shell',
        verdict: 'deny_pending_approval',
        reason: 'missing_trusted_cwd',
        wouldBlock: true,
        fingerprint: createHash('sha256').update('rotated-availability').digest('hex'),
        ...cohort,
      },
      DEFAULT_REDACTION_V3,
      tinyRetention,
    )
    await unlink(`${auditPath}.readiness.json`)
    await appendAuditRecord(
      auditPath,
      {
        timestamp: '2026-09-08T02:01:00.000Z',
        event: 'beforeShellExecution',
        kind: 'shell',
        verdict: 'allow',
        reason: 'read_only',
        wouldBlock: false,
        ...cohort,
      },
      DEFAULT_REDACTION_V3,
      tinyRetention,
    )
    const cleanRecords = Array.from({ length: 150 }, (_, index) => ({
      timestamp: new Date(1_780_100_000_000 + index).toISOString(),
      event: 'beforeShellExecution',
      kind: 'shell',
      verdict: 'allow',
      reason: 'read_only',
      wouldBlock: false,
      mode: 'audit',
      fingerprint: REVIEWED_FINGERPRINT,
      sessionCorrelationId: SESSION_IDS[index % SESSION_IDS.length],
      ...cohort,
    }))
    await appendAuditRecord(auditPath, cleanRecords[0] ?? {}, DEFAULT_REDACTION_V3, tinyRetention)
    await writeFile(
      auditPath,
      `${cleanRecords
        .slice(1)
        .map((record) => JSON.stringify(record))
        .join('\n')}\n`,
      { flag: 'a' },
    )

    const report = await qualityCheck({
      targetDir: repoRoot,
      corpusDir: await writeCorpus(repoRoot, passingCorpus),
    })

    expect(report.audit.gateEvents).toBe(150)
    expect(report.audit.reviewedBenignEvents).toBe(150)
    expect(report.audit.availabilityAsks).toBe(1)
    expect(report.audit.availabilityWatermarkStatus).toBe('current')
    expect(report.trafficReadyForEnforce).toBe(false)
    expect(report.readyForEnforce).toBe(false)
    expect(report.failedGates).toContain('Availability-caused asks: 1 (required: 0).')
  })

  it('lists every traffic and corpus failure instead of hiding failures after the first', async () => {
    const repoRoot = await mkdtemp(path.join(os.tmpdir(), 'belay-quality-all-failures-'))
    tempDirs.push(repoRoot)
    await seedReviewedTraffic(repoRoot, 149)
    const config = await loadConfigFile(repoRoot)
    const cohort = await resolveActiveAuditCohort(repoRoot, config)
    expect(cohort).not.toBeNull()
    if (!cohort) {
      throw new Error('fixture active cohort unavailable')
    }
    const auditPath = path.join(repoRoot, config.audit.logPath)
    await writeFile(
      auditPath,
      `${await readFile(auditPath, 'utf8')}${JSON.stringify({
        event: 'beforeShellExecution',
        kind: 'shell',
        verdict: 'deny_pending_approval',
        reason: 'missing_trusted_cwd',
        wouldBlock: true,
        ...cohort,
      })}\n`,
    )
    const corpusDir = await writeCorpus(repoRoot, [
      {
        kind: 'shell',
        category: 'must-ask',
        command: 'git status',
        verdict: 'deny_pending_approval',
      },
      {
        kind: 'shell',
        category: 'provably-benign',
        command: 'git push origin main',
        verdict: 'allow',
      },
    ])

    const report = await qualityCheck({ targetDir: repoRoot, corpusDir })
    const formatted = formatQualityReport(report)

    expect(report.failedGates).toEqual([
      'Corpus MUST-ASK misses: 1 (required: 0).',
      'Corpus provably-benign blocks: 1 (required: 0).',
      'Reviewed provably-benign events: 149 (required: at least 150).',
      'Availability-caused asks: 1 (required: 0).',
    ])
    for (const failure of report.failedGates) {
      expect(formatted).toContain(failure)
    }
  })
})
