import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { formatCliHelp, parseArgs } from '../cli.js'
import {
  formatHarvestReport,
  harvestApplyProject,
  harvestListProject,
  harvestReportFromNdjson,
} from '../commands/harvest.js'
import { loadConfigFile } from '../config-io.js'
import { toAuditRecord } from '../core/audit-query.js'
import { approvalCorrelationId, serializeAuditRecordV3 } from '../core/audit-serialize.js'
import { DEFAULT_REDACTION_V3 } from '../core/config.js'
import {
  applyHarvestReview,
  buildHarvestReport,
  extractAvailabilityQueue,
  extractHarvestCandidates,
  filterRecordsForHarvest,
  selectHarvestCohort,
} from '../core/harvest.js'
import { loadHarvestReviewLedger, writeHarvestReviewLedgerAtomic } from '../core/harvest-review.js'
import { initProject } from '../installer.js'
import { resolveActiveAuditCohort } from '../runtime-provenance.js'

const tempDirs: string[] = []

async function createHarvestFixtureRepo(): Promise<string> {
  const repoRoot = await mkdtemp(path.join(os.tmpdir(), 'agent-belay-harvest-'))
  tempDirs.push(repoRoot)
  await initProject({ targetDir: repoRoot })
  return repoRoot
}

function testFingerprint(label: string): string {
  return createHash('sha256').update(label).digest('hex')
}

function shellDeny(params: Record<string, unknown>) {
  return toAuditRecord({
    event: 'beforeShellExecution',
    kind: 'shell',
    verdict: 'deny_pending_approval',
    wouldBlock: true,
    ...params,
  })
}

describe('harvest', () => {
  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
  })

  it('scopes default project harvest to the installed active cohort', async () => {
    const repoRoot = await createHarvestFixtureRepo()
    const config = await loadConfigFile(repoRoot)
    const cohort = await resolveActiveAuditCohort(repoRoot, config)
    expect(cohort).not.toBeNull()
    if (!cohort) {
      throw new Error('fixture active cohort unavailable')
    }

    const oldCohort = {
      ...cohort,
      runtimeArtifactHash: testFingerprint('old-runtime-artifact'),
    }
    const currentCohort = cohort
    const records = [
      ...[1, 2].map((index) => ({
        event: 'beforeShellExecution',
        kind: 'shell',
        verdict: 'deny_pending_approval',
        wouldBlock: true,
        fingerprint: testFingerprint('old-repeated-ask'),
        summary: 'old command',
        reason: 'unknown_local_effect',
        ...oldCohort,
        timestamp: `2026-01-01T00:00:0${index}.000Z`,
      })),
      ...[1, 2].map((index) => ({
        event: 'beforeShellExecution',
        kind: 'shell',
        verdict: 'deny_pending_approval',
        wouldBlock: true,
        fingerprint: testFingerprint('current-repeated-ask'),
        summary: 'current command',
        reason: 'unknown_local_effect',
        ...currentCohort,
        timestamp: `2026-01-02T00:00:0${index}.000Z`,
      })),
    ]
    await writeFile(
      path.join(repoRoot, config.audit.logPath),
      `${records.map((record) => JSON.stringify(record)).join('\n')}\n`,
    )

    const currentReport = await harvestListProject({ targetDir: repoRoot })
    const allReport = await harvestListProject({ targetDir: repoRoot, allCohorts: true })

    expect(currentReport.candidates.map((entry) => entry.command)).toEqual(['current command'])
    expect(currentReport.candidates[0]?.boundaryProfile).toBe(currentCohort.boundaryProfile)
    expect(currentReport.excludedGateEvents).toBe(2)
    expect(allReport.candidates.map((entry) => entry.command)).toEqual([
      'current command',
      'old command',
    ])
  })

  it('keeps the same command and fingerprint separate across recorded boundaries', async () => {
    const repoRoot = await createHarvestFixtureRepo()
    const config = await loadConfigFile(repoRoot)
    const cohort = await resolveActiveAuditCohort(repoRoot, config)
    expect(cohort).not.toBeNull()
    if (!cohort) {
      throw new Error('fixture active cohort unavailable')
    }
    const command = 'git diff --stat'
    const fingerprint = testFingerprint('same-command-and-fingerprint')
    const records = ['l3-l4-only', 'l1-attested-boundary'].flatMap(
      (boundaryProfile, boundaryIndex) =>
        [1, 2].map((askIndex) => ({
          event: 'beforeShellExecution',
          kind: 'shell',
          verdict: 'deny_pending_approval',
          wouldBlock: true,
          fingerprint,
          summary: command,
          reason: 'unknown_local_effect',
          ...cohort,
          boundaryProfile,
          timestamp: `2026-09-07T00:0${boundaryIndex}:0${askIndex}.000Z`,
        })),
    )
    await writeFile(
      path.join(repoRoot, config.audit.logPath),
      `${records.map((record) => JSON.stringify(record)).join('\n')}\n`,
    )

    const report = await harvestListProject({ targetDir: repoRoot, allCohorts: true })

    expect(report.candidates).toHaveLength(2)
    expect(report.candidates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ fingerprint, boundaryProfile: 'l3-l4-only', askCount: 2 }),
        expect.objectContaining({
          fingerprint,
          boundaryProfile: 'l1-attested-boundary',
          askCount: 2,
        }),
      ]),
    )

    const text = formatHarvestReport(report)
    expect(text).toContain('boundary="l3-l4-only"')
    expect(text).toContain('boundary="l1-attested-boundary"')
    expect(text).toContain('(fingerprint, kind, boundaryProfile)')
    expect(text).not.toContain('reviewed at the active boundary')
  })

  it('fails closed without selectors when the same command spans two review keys', async () => {
    const repoRoot = await createHarvestFixtureRepo()
    const config = await loadConfigFile(repoRoot)
    const cohort = await resolveActiveAuditCohort(repoRoot, config)
    expect(cohort).not.toBeNull()
    if (!cohort) {
      throw new Error('fixture active cohort unavailable')
    }
    const command = 'git diff --stat'
    const fingerprint = testFingerprint('ambiguous-boundary-review')
    const records = ['l3-l4-only', 'l1-attested-boundary'].flatMap(
      (boundaryProfile, boundaryIndex) =>
        [1, 2].map((askIndex) => ({
          event: 'beforeShellExecution',
          kind: 'shell',
          verdict: 'deny_pending_approval',
          wouldBlock: true,
          fingerprint,
          summary: command,
          reason: 'unknown_local_effect',
          ...cohort,
          boundaryProfile,
          timestamp: `2026-09-07T00:0${boundaryIndex}:0${askIndex}.000Z`,
        })),
    )
    const auditPath = path.join(repoRoot, config.audit.logPath)
    await writeFile(auditPath, `${records.map((record) => JSON.stringify(record)).join('\n')}\n`)
    const corpusPath = path.join(repoRoot, 'shell-commands.json')
    await writeFile(corpusPath, '[]\n')

    const result = await harvestApplyProject({
      targetDir: repoRoot,
      corpusPath,
      command,
      outcome: 'accepted-benign',
      allCohorts: true,
    })

    expect(result.ok).toBe(false)
    expect(result.message).toMatch(/--fingerprint.*--boundary-profile/i)
    expect(await readFile(corpusPath, 'utf8')).toBe('[]\n')
    expect(
      await loadHarvestReviewLedger(path.join(path.dirname(auditPath), 'harvest-reviews.json')),
    ).toEqual({ version: 1, reviews: [] })
  })

  it('hides only the reviewed boundary when a fingerprint is shared', async () => {
    const repoRoot = await createHarvestFixtureRepo()
    const config = await loadConfigFile(repoRoot)
    const cohort = await resolveActiveAuditCohort(repoRoot, config)
    expect(cohort).not.toBeNull()
    if (!cohort) {
      throw new Error('fixture active cohort unavailable')
    }
    const fingerprint = testFingerprint('shared-fingerprint-review')
    const records = ['l3-l4-only', 'l1-attested-boundary'].flatMap(
      (boundaryProfile, boundaryIndex) =>
        [1, 2].map((askIndex) => ({
          event: 'beforeShellExecution',
          kind: 'shell',
          verdict: 'deny_pending_approval',
          wouldBlock: true,
          fingerprint,
          summary: 'pnpm test',
          reason: 'unknown_local_effect',
          ...cohort,
          boundaryProfile,
          timestamp: `2026-09-07T00:0${boundaryIndex}:0${askIndex}.000Z`,
        })),
    )
    const auditPath = path.join(repoRoot, config.audit.logPath)
    await writeFile(auditPath, `${records.map((record) => JSON.stringify(record)).join('\n')}\n`)
    await writeHarvestReviewLedgerAtomic(
      path.join(path.dirname(auditPath), 'harvest-reviews.json'),
      {
        version: 1,
        reviews: [
          {
            fingerprint,
            kind: 'shell',
            boundaryProfile: 'l1-attested-boundary',
            outcome: 'reject',
            reviewedAt: '2026-09-07T01:00:00.000Z',
          },
        ],
      },
    )

    const report = await harvestListProject({ targetDir: repoRoot, allCohorts: true })

    expect(report.candidates).toEqual([
      expect.objectContaining({ fingerprint, boundaryProfile: 'l3-l4-only' }),
    ])
  })

  it('leaves a legacy mixed-history boundary unknown and refuses to review it', async () => {
    const repoRoot = await createHarvestFixtureRepo()
    const config = await loadConfigFile(repoRoot)
    const command = 'legacy opaque command'
    const fingerprint = testFingerprint('legacy-boundaryless-candidate')
    const records = [1, 2].map((askIndex) => ({
      event: 'beforeShellExecution',
      kind: 'shell',
      verdict: 'deny_pending_approval',
      wouldBlock: true,
      fingerprint,
      summary: command,
      reason: 'unknown_local_effect',
      timestamp: `2026-09-07T00:00:0${askIndex}.000Z`,
    }))
    const auditPath = path.join(repoRoot, config.audit.logPath)
    await writeFile(auditPath, `${records.map((record) => JSON.stringify(record)).join('\n')}\n`)
    const corpusPath = path.join(repoRoot, 'shell-commands.json')
    await writeFile(corpusPath, '[]\n')

    const report = await harvestListProject({ targetDir: repoRoot, allCohorts: true })
    const result = await harvestApplyProject({
      targetDir: repoRoot,
      corpusPath,
      command,
      outcome: 'accepted-benign',
      allCohorts: true,
    })

    expect(report.candidates).toEqual([
      expect.objectContaining({ fingerprint, boundaryProfile: null }),
    ])
    expect(formatHarvestReport(report)).toContain('boundary=legacy/unknown (null)')
    expect(result.ok).toBe(false)
    expect(result.message).toMatch(/boundary profile.*unavailable/i)
    expect(await readFile(corpusPath, 'utf8')).toBe('[]\n')
    expect(
      await loadHarvestReviewLedger(path.join(path.dirname(auditPath), 'harvest-reviews.json')),
    ).toEqual({ version: 1, reviews: [] })
  })

  it('parses and documents the boundary selector only for harvest apply', () => {
    const apply = parseArgs([
      'harvest',
      'apply',
      '--command',
      'git diff --stat',
      '--outcome',
      'reject',
      '--all-cohorts',
      '--boundary-profile',
      'l1-attested-boundary',
    ])

    expect(apply.options.boundaryProfile).toBe('l1-attested-boundary')
    expect(apply.options.allCohorts).toBe(true)
    expect(formatCliHelp()).toContain('[--boundary-profile <id>]')
    expect(() =>
      parseArgs(['harvest', 'list', '--boundary-profile', 'l1-attested-boundary']),
    ).toThrow(/--boundary-profile.*harvest apply/i)
  })

  it('fails closed when the active cohort cannot be resolved', async () => {
    const repoRoot = await createHarvestFixtureRepo()
    const config = await loadConfigFile(repoRoot)
    await writeFile(
      path.join(repoRoot, config.audit.logPath),
      `${JSON.stringify({
        event: 'beforeShellExecution',
        kind: 'shell',
        verdict: 'deny_pending_approval',
        wouldBlock: true,
        fingerprint: testFingerprint('historical-ask'),
        summary: 'historical command',
        reason: 'unknown_local_effect',
      })}\n`,
    )
    await unlink(path.join(repoRoot, '.cursor', 'belay', 'runtime', 'core.mjs'))

    const report = await harvestListProject({ targetDir: repoRoot })

    expect(report.candidates).toEqual([])
    expect(report.notes.join(' ')).toMatch(/active audit cohort.*unavailable/i)
  })

  it('attributes matching legacy active-cohort records to the selected active boundary', async () => {
    const repoRoot = await createHarvestFixtureRepo()
    const config = await loadConfigFile(repoRoot)
    const cohort = await resolveActiveAuditCohort(repoRoot, config)
    expect(cohort).not.toBeNull()
    if (!cohort) {
      throw new Error('fixture active cohort unavailable')
    }
    const fingerprint = testFingerprint('legacy-active-candidate')
    const records = [1, 2].map((askIndex) => ({
      event: 'beforeShellExecution',
      kind: 'shell',
      verdict: 'deny_pending_approval',
      wouldBlock: true,
      fingerprint,
      summary: 'legacy active command',
      reason: 'unknown_local_effect',
      runtimeBuildStamp: cohort.runtimeBuildStamp,
      configFingerprint: cohort.configFingerprint,
      timestamp: `2026-09-07T00:00:0${askIndex}.000Z`,
    }))
    await writeFile(
      path.join(repoRoot, config.audit.logPath),
      `${records.map((record) => JSON.stringify(record)).join('\n')}\n`,
    )

    const report = await harvestListProject({ targetDir: repoRoot })

    expect(report.candidates).toEqual([
      expect.objectContaining({ fingerprint, boundaryProfile: cohort.boundaryProfile }),
    ])
  })

  it('excludes a stale wrapper ask while current allow evidence remains non-candidate', async () => {
    const repoRoot = await createHarvestFixtureRepo()
    const config = await loadConfigFile(repoRoot)
    const cohort = await resolveActiveAuditCohort(repoRoot, config)
    expect(cohort).not.toBeNull()
    const oldCohort = {
      ...cohort!,
      runtimeArtifactHash: testFingerprint('stale-wrapper-runtime'),
    }
    const records = [
      ...[1, 2].map((index) => ({
        event: 'beforeShellExecution',
        kind: 'shell',
        verdict: 'deny_pending_approval',
        wouldBlock: true,
        fingerprint: testFingerprint('stale-wrapper-ask'),
        summary: 'rtk git status --short',
        reason: 'unknown_local_effect',
        ...oldCohort,
        timestamp: `2026-01-01T00:00:0${index}.000Z`,
      })),
      {
        event: 'beforeShellExecution',
        kind: 'shell',
        verdict: 'allow',
        wouldBlock: false,
        fingerprint: testFingerprint('current-wrapper-allow'),
        summary: 'rtk git status --short',
        reason: 'read_only',
        ...cohort!,
        timestamp: '2026-01-02T00:00:00.000Z',
      },
    ]
    await writeFile(
      path.join(repoRoot, config.audit.logPath),
      `${records.map((record) => JSON.stringify(record)).join('\n')}\n`,
    )

    const report = await harvestListProject({ targetDir: repoRoot })

    expect(report.candidates).toEqual([])
    expect(report.excludedGateEvents).toBe(2)
  })

  it('retains serialized v3 approval correlation for active-cohort round trips', async () => {
    const repoRoot = await createHarvestFixtureRepo()
    const config = await loadConfigFile(repoRoot)
    const cohort = await resolveActiveAuditCohort(repoRoot, config)
    expect(cohort).not.toBeNull()
    const approvalId = 'belay_harvest_correlation_fixture'
    const fingerprint = testFingerprint('serialized-approval-round-trip')
    const serializedRecords = [
      serializeAuditRecordV3(
        {
          timestamp: '2026-01-02T00:00:00.000Z',
          event: 'beforeShellExecution',
          kind: 'shell',
          verdict: 'deny_pending_approval',
          wouldBlock: true,
          fingerprint,
          summary: 'pnpm test',
          reason: 'unknown_local_effect',
          approvalId,
          ...cohort!,
        },
        DEFAULT_REDACTION_V3,
      ),
      serializeAuditRecordV3(
        {
          timestamp: '2026-01-02T00:00:01.000Z',
          event: 'approval',
          reason: 'approval_recorded',
          approvalId,
          ...cohort!,
        },
        DEFAULT_REDACTION_V3,
      ),
    ]
    expect(serializedRecords[0]?.approvalId).toBeUndefined()
    expect(serializedRecords[0]?.approvalCorrelationId).toBe(approvalCorrelationId(approvalId))
    await writeFile(
      path.join(repoRoot, config.audit.logPath),
      `${serializedRecords.map((record) => JSON.stringify(record)).join('\n')}\n`,
    )

    const report = await harvestListProject({ targetDir: repoRoot })

    expect(report.candidates).toEqual([
      expect.objectContaining({
        command: 'pnpm test',
        approvedAfterDeny: true,
        sources: expect.arrayContaining(['deny_then_approve']),
      }),
    ])
  })

  it('groups active-cohort asks and approval evidence across retained generations', async () => {
    const repoRoot = await createHarvestFixtureRepo()
    const config = await loadConfigFile(repoRoot)
    const cohort = await resolveActiveAuditCohort(repoRoot, config)
    expect(cohort).not.toBeNull()
    if (!cohort) {
      throw new Error('fixture active cohort unavailable')
    }
    const approvalId = 'belay_retained_generation_harvest'
    const fingerprint = testFingerprint('retained-generation-harvest')
    const deny = (timestamp: string) =>
      serializeAuditRecordV3(
        {
          timestamp,
          event: 'beforeShellExecution',
          kind: 'shell',
          verdict: 'deny_pending_approval',
          wouldBlock: true,
          fingerprint,
          summary: 'pnpm test',
          reason: 'unknown_local_effect',
          approvalId,
          ...cohort,
        },
        DEFAULT_REDACTION_V3,
      )
    const approval = serializeAuditRecordV3(
      {
        timestamp: '2026-09-08T00:00:02.000Z',
        event: 'approval',
        reason: 'approval_recorded',
        approvalId,
        ...cohort,
      },
      DEFAULT_REDACTION_V3,
    )
    const auditPath = path.join(repoRoot, config.audit.logPath)
    await writeFile(
      `${auditPath}.2`,
      `${JSON.stringify(deny('2026-09-08T00:00:00.000Z'))}\n`,
      'utf8',
    )
    await writeFile(
      `${auditPath}.1`,
      `${JSON.stringify(deny('2026-09-08T00:00:01.000Z'))}\n`,
      'utf8',
    )
    await writeFile(auditPath, `${JSON.stringify(approval)}\n`, 'utf8')

    const report = await harvestListProject({ targetDir: repoRoot })

    expect(report.candidates).toEqual([
      expect.objectContaining({
        fingerprint,
        command: 'pnpm test',
        askCount: 2,
        approvedAfterDeny: true,
        sources: expect.arrayContaining(['deny_then_approve']),
      }),
    ])
  })

  it('hides matching-boundary reviews by default and includes them when requested', async () => {
    const repoRoot = await createHarvestFixtureRepo()
    const config = await loadConfigFile(repoRoot)
    const cohort = await resolveActiveAuditCohort(repoRoot, config)
    expect(cohort).not.toBeNull()
    if (!cohort) {
      throw new Error('fixture active cohort unavailable')
    }
    const fingerprint = testFingerprint('reviewed-current-candidate')
    const records = [1, 2].map((index) => ({
      event: 'beforeShellExecution',
      kind: 'shell',
      verdict: 'deny_pending_approval',
      wouldBlock: true,
      fingerprint,
      summary: 'pnpm test',
      reason: 'unknown_local_effect',
      ...cohort,
      timestamp: `2026-09-07T00:00:0${index}.000Z`,
    }))
    const auditPath = path.join(repoRoot, config.audit.logPath)
    await writeFile(auditPath, `${records.map((record) => JSON.stringify(record)).join('\n')}\n`)
    await writeHarvestReviewLedgerAtomic(
      path.join(path.dirname(auditPath), 'harvest-reviews.json'),
      {
        version: 1,
        reviews: [
          {
            fingerprint,
            kind: 'shell',
            boundaryProfile: cohort.boundaryProfile,
            outcome: 'accepted-benign',
            reviewedAt: '2026-09-07T01:00:00.000Z',
          },
        ],
      },
    )

    expect((await harvestListProject({ targetDir: repoRoot })).candidates).toEqual([])
    expect(
      (await harvestListProject({ targetDir: repoRoot, includeReviewed: true })).candidates,
    ).toEqual([expect.objectContaining({ fingerprint })])
  })

  it('does not hide a review from a different boundary profile', async () => {
    const repoRoot = await createHarvestFixtureRepo()
    const config = await loadConfigFile(repoRoot)
    const cohort = await resolveActiveAuditCohort(repoRoot, config)
    expect(cohort).not.toBeNull()
    if (!cohort) {
      throw new Error('fixture active cohort unavailable')
    }
    const fingerprint = testFingerprint('other-boundary-candidate')
    const records = [1, 2].map((index) => ({
      event: 'beforeShellExecution',
      kind: 'shell',
      verdict: 'deny_pending_approval',
      wouldBlock: true,
      fingerprint,
      summary: 'pnpm test',
      reason: 'unknown_local_effect',
      ...cohort,
      timestamp: `2026-09-07T00:00:0${index}.000Z`,
    }))
    const auditPath = path.join(repoRoot, config.audit.logPath)
    await writeFile(auditPath, `${records.map((record) => JSON.stringify(record)).join('\n')}\n`)
    await writeHarvestReviewLedgerAtomic(
      path.join(path.dirname(auditPath), 'harvest-reviews.json'),
      {
        version: 1,
        reviews: [
          {
            fingerprint,
            kind: 'shell',
            boundaryProfile: 'l1-attested-boundary',
            outcome: 'accepted-benign',
            reviewedAt: '2026-09-07T01:00:00.000Z',
          },
        ],
      },
    )

    expect((await harvestListProject({ targetDir: repoRoot })).candidates).toEqual([
      expect.objectContaining({ fingerprint }),
    ])
  })

  it('apply does not fall back to a historical command unless all cohorts are explicit', async () => {
    const repoRoot = await createHarvestFixtureRepo()
    const config = await loadConfigFile(repoRoot)
    const cohort = await resolveActiveAuditCohort(repoRoot, config)
    expect(cohort).not.toBeNull()
    if (!cohort) {
      throw new Error('fixture active cohort unavailable')
    }
    const historicalCommand = 'historical exact command'
    const historicalFingerprint = testFingerprint(historicalCommand)
    const historicalCohort = {
      ...cohort,
      runtimeArtifactHash: testFingerprint('historical-runtime'),
    }
    const records = [1, 2].map((index) => ({
      event: 'beforeShellExecution',
      kind: 'shell',
      verdict: 'deny_pending_approval',
      wouldBlock: true,
      fingerprint: historicalFingerprint,
      summary: historicalCommand,
      reason: 'unknown_local_effect',
      ...historicalCohort,
      timestamp: `2026-09-07T00:00:0${index}.000Z`,
    }))
    await writeFile(
      path.join(repoRoot, config.audit.logPath),
      `${records.map((record) => JSON.stringify(record)).join('\n')}\n`,
    )
    const corpusPath = path.join(repoRoot, 'shell-commands.json')
    await writeFile(corpusPath, '[]\n')

    const scoped = await harvestApplyProject({
      targetDir: repoRoot,
      corpusPath,
      command: historicalCommand,
      outcome: 'reject',
    })
    const forensic = await harvestApplyProject({
      targetDir: repoRoot,
      corpusPath,
      command: historicalCommand,
      outcome: 'reject',
      allCohorts: true,
    })

    expect(scoped.ok).toBe(false)
    expect(scoped.message).toMatch(/selected harvest report/i)
    expect(forensic.ok).toBe(true)
  })

  it('fails closed when an exact command matches multiple candidate fingerprints', async () => {
    const repoRoot = await createHarvestFixtureRepo()
    const config = await loadConfigFile(repoRoot)
    const cohort = await resolveActiveAuditCohort(repoRoot, config)
    expect(cohort).not.toBeNull()
    if (!cohort) {
      throw new Error('fixture active cohort unavailable')
    }
    const command = 'git diff --stat'
    const firstFingerprint = testFingerprint('same-command-first-cwd')
    const secondFingerprint = testFingerprint('same-command-second-cwd')
    const records = [firstFingerprint, secondFingerprint].flatMap((fingerprint, fingerprintIndex) =>
      [1, 2].map((askIndex) => ({
        event: 'beforeShellExecution',
        kind: 'shell',
        verdict: 'deny_pending_approval',
        wouldBlock: true,
        fingerprint,
        summary: command,
        reason: 'unknown_local_effect',
        ...cohort,
        timestamp: `2026-09-07T00:0${fingerprintIndex}:0${askIndex}.000Z`,
      })),
    )
    const auditPath = path.join(repoRoot, config.audit.logPath)
    await writeFile(auditPath, `${records.map((record) => JSON.stringify(record)).join('\n')}\n`)
    const corpusPath = path.join(repoRoot, 'shell-commands.json')
    await writeFile(corpusPath, '[]\n')

    const result = await harvestApplyProject({
      targetDir: repoRoot,
      corpusPath,
      command,
      outcome: 'reject',
    })

    expect(result.ok).toBe(false)
    expect(result.message).toMatch(/multiple candidate fingerprints/i)
    expect(
      await loadHarvestReviewLedger(path.join(path.dirname(auditPath), 'harvest-reviews.json')),
    ).toEqual({ version: 1, reviews: [] })

    const malformedFingerprint = await harvestApplyProject({
      targetDir: repoRoot,
      corpusPath,
      command,
      outcome: 'reject',
      fingerprint: 'not-a-fingerprint',
    })
    expect(malformedFingerprint.ok).toBe(false)
    expect(malformedFingerprint.message).toMatch(/fingerprint.*64-hex/i)
    expect(
      await loadHarvestReviewLedger(path.join(path.dirname(auditPath), 'harvest-reviews.json')),
    ).toEqual({ version: 1, reviews: [] })

    const missingPair = await harvestApplyProject({
      targetDir: repoRoot,
      corpusPath,
      command,
      outcome: 'reject',
      fingerprint: testFingerprint('not-a-candidate-for-command'),
    })
    expect(missingPair.ok).toBe(false)
    expect(missingPair.message).toMatch(/command and fingerprint/i)
    expect(
      await loadHarvestReviewLedger(path.join(path.dirname(auditPath), 'harvest-reviews.json')),
    ).toEqual({ version: 1, reviews: [] })

    const selected = await harvestApplyProject({
      targetDir: repoRoot,
      corpusPath,
      command,
      outcome: 'reject',
      fingerprint: secondFingerprint,
    })
    expect(selected.ok).toBe(true)
    expect(
      await loadHarvestReviewLedger(path.join(path.dirname(auditPath), 'harvest-reviews.json')),
    ).toMatchObject({
      reviews: [{ fingerprint: secondFingerprint, outcome: 'reject' }],
    })
  })

  it('selects only active-cohort records unless historical review is explicit', () => {
    const activeCohort = {
      runtimeBuildStamp: '1.0.0@active',
      runtimeArtifactHash: testFingerprint('active-runtime'),
      decisionConfigFingerprint: testFingerprint('active-config'),
      configFingerprint: testFingerprint('active-display-config'),
      boundaryProfile: 'l3-l4-only',
    }
    const active = shellDeny({
      fingerprint: testFingerprint('active-candidate'),
      summary: 'git status',
      reason: 'unknown_local_effect',
      runtimeArtifactHash: activeCohort.runtimeArtifactHash,
      decisionConfigFingerprint: activeCohort.decisionConfigFingerprint,
      boundaryProfile: activeCohort.boundaryProfile,
    })
    const historical = shellDeny({
      fingerprint: testFingerprint('historical-candidate'),
      summary: 'git diff',
      reason: 'unknown_local_effect',
      runtimeArtifactHash: testFingerprint('historical-runtime'),
      decisionConfigFingerprint: activeCohort.decisionConfigFingerprint,
      boundaryProfile: activeCohort.boundaryProfile,
    })

    const selected = selectHarvestCohort([active, historical], activeCohort, false)
    expect(selected).toEqual({
      records: [active],
      cohortScope: 'active',
      excludedRecords: 1,
    })

    const all = selectHarvestCohort([active, historical], activeCohort, true)
    expect(all).toEqual({
      records: [active, historical],
      cohortScope: 'all',
      excludedRecords: 0,
    })
  })

  it('does not treat history as active evidence when runtime provenance is unavailable', () => {
    const historical = shellDeny({
      fingerprint: testFingerprint('historical-only'),
      summary: 'git status',
      reason: 'unknown_local_effect',
    })

    expect(selectHarvestCohort([historical], null, false)).toEqual({
      records: [],
      cohortScope: 'active',
      excludedRecords: 1,
    })
  })

  it('separates availability-caused asks from benign candidates', () => {
    const records = [
      shellDeny({
        fingerprint: testFingerprint('fp-avail'),
        summary: 'git status',
        reason: 'unknown_local_effect',
        judgeFallbackReason: 'eval_timeout',
      }),
      shellDeny({
        fingerprint: testFingerprint('fp-dynamic-cwd'),
        summary: 'cd "$dir" && rm -rf build',
        reason: 'dynamic_cwd_transition',
      }),
      shellDeny({
        fingerprint: testFingerprint('fp-classifier'),
        summary: 'git status',
        reason: 'unknown_local_effect',
      }),
      shellDeny({
        fingerprint: testFingerprint('fp-classifier'),
        summary: 'git status',
        reason: 'unknown_local_effect',
      }),
    ]

    const report = buildHarvestReport(records)
    expect(report.availabilityQueue).toHaveLength(2)
    expect(report.availabilityQueue).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ availabilitySignal: 'judge_timeout' }),
        expect.objectContaining({
          availabilitySignal: 'dynamic_cwd_transition',
          reason: 'dynamic_cwd_transition',
        }),
      ]),
    )
    expect(
      report.candidates.some((entry) => entry.fingerprint === testFingerprint('fp-avail')),
    ).toBe(false)
    expect(
      report.candidates.some((entry) => entry.fingerprint === testFingerprint('fp-dynamic-cwd')),
    ).toBe(false)
    expect(
      report.candidates.some((entry) => entry.fingerprint === testFingerprint('fp-classifier')),
    ).toBe(true)
  })

  it('keeps paired deny rows when --since filters only the approval event', () => {
    const records = [
      shellDeny({
        timestamp: '2026-01-01T00:00:00.000Z',
        fingerprint: testFingerprint('fp-since-pair'),
        summary: 'pnpm test',
        reason: 'unknown_local_effect',
        approvalId: 'belay_since_pair',
      }),
      toAuditRecord({
        event: 'approval',
        reason: 'approval_recorded',
        approvalId: 'belay_since_pair',
        timestamp: '2026-01-02T00:00:00.000Z',
      }),
    ]

    const report = buildHarvestReport(
      filterRecordsForHarvest(records, { since: '2026-01-02T00:00:00.000Z' }),
    )
    expect(report.candidates).toHaveLength(1)
    expect(report.candidates[0]?.sources).toContain('deny_then_approve')
  })

  it('harvest list filter keeps approval events for deny-then-approve detection', () => {
    const records = [
      shellDeny({
        timestamp: '2026-01-01T00:00:00.000Z',
        fingerprint: testFingerprint('fp-list-path'),
        summary: 'pnpm test',
        reason: 'unknown_local_effect',
        approvalId: 'belay_list123',
      }),
      toAuditRecord({
        event: 'approval',
        reason: 'approval_recorded',
        approvalId: 'belay_list123',
        timestamp: '2026-01-01T00:01:00.000Z',
      }),
    ]

    const report = buildHarvestReport(filterRecordsForHarvest(records))
    expect(report.candidates).toHaveLength(1)
    expect(report.candidates[0]?.sources).toContain('deny_then_approve')
  })

  it('includes deny-then-approve shell round trips as candidates only', () => {
    const records = [
      shellDeny({
        timestamp: '2026-01-01T00:00:00.000Z',
        fingerprint: testFingerprint('fp-trip'),
        summary: 'pnpm test',
        reason: 'unknown_local_effect',
        approvalId: 'belay_abc123',
      }),
      toAuditRecord({
        event: 'approval',
        reason: 'approval_recorded',
        approvalId: 'belay_abc123',
        timestamp: '2026-01-01T00:01:00.000Z',
      }),
    ]

    const candidates = extractHarvestCandidates(records)
    expect(candidates).toHaveLength(1)
    expect(candidates[0]?.sources).toContain('deny_then_approve')
    expect(candidates[0]?.approvedAfterDeny).toBe(true)
  })

  it('tags read-style shell commands as static-signal candidates', () => {
    const records = [
      shellDeny({
        fingerprint: testFingerprint('fp-read'),
        summary: 'git diff --stat',
        reason: 'unknown_local_effect',
      }),
    ]

    const candidates = extractHarvestCandidates(records)
    expect(candidates[0]?.sources).toContain('read_style_signal')
  })

  it('does not mix tool audit events into shell harvest scope', () => {
    const records = [
      toAuditRecord({
        event: 'preToolUse',
        kind: 'tool',
        verdict: 'deny_pending_approval',
        wouldBlock: true,
        fingerprint: 'tool-fp',
        summary: 'read_file',
        reason: 'unknown_local_effect',
      }),
      shellDeny({
        fingerprint: 'shell-fp',
        summary: 'ls -la',
        reason: 'read_only',
      }),
    ]

    expect(extractHarvestCandidates(records).every((entry) => entry.kind === 'shell')).toBe(true)
    expect(extractAvailabilityQueue(records)).toHaveLength(0)
  })

  it('persists reviewed accepted-benign and provably-benign outcomes', () => {
    const base = [
      {
        kind: 'shell' as const,
        category: 'provably-benign' as const,
        command: 'git status',
        verdict: 'allow' as const,
      },
    ]

    const accepted = applyHarvestReview(base, {
      command: 'touch notes.txt',
      outcome: 'accepted-benign',
      fingerprint: testFingerprint('touch notes'),
      reviewedAt: '2026-09-07T00:00:00.000Z',
    })
    expect(accepted.applied).toBe(true)
    expect(accepted.ok).toBe(true)
    expect(accepted.cases.at(-1)).toMatchObject({
      category: 'accepted-benign',
      verdict: 'allow_flagged',
    })
    expect(accepted.cases.at(-1)).not.toHaveProperty('reason')

    const promoted = applyHarvestReview(accepted.cases, {
      command: 'rg TODO',
      outcome: 'provably-benign',
      reason: 'read_only',
      fingerprint: testFingerprint('rg todo'),
      reviewedAt: '2026-09-07T00:01:00.000Z',
    })
    expect(promoted.applied).toBe(true)
    expect(promoted.ok).toBe(true)
    expect(promoted.message).toContain('pnpm corpus')
    expect(promoted.message).toContain('CI')
    expect(promoted.message).not.toContain('pnpm build')
    expect(promoted.message).not.toContain('standing-allow')
    expect(promoted.cases.at(-1)).toMatchObject({
      category: 'provably-benign',
      verdict: 'allow',
      reason: 'read_only',
    })

    const rejected = applyHarvestReview(promoted.cases, {
      command: 'make deploy',
      outcome: 'reject',
      fingerprint: testFingerprint('make deploy'),
      reviewedAt: '2026-09-07T00:02:00.000Z',
    })
    expect(rejected.applied).toBe(false)
    expect(rejected.ok).toBe(true)
    expect(rejected.message).toContain('Reviewed and rejected')
    expect(rejected.cases).toHaveLength(promoted.cases.length)
  })

  it('parses ndjson via harvest command helper', () => {
    const raw = `${JSON.stringify({
      event: 'beforeShellExecution',
      kind: 'shell',
      verdict: 'deny_pending_approval',
      wouldBlock: true,
      fingerprint: testFingerprint('fp'),
      summary: 'git status',
      reason: 'missing_trusted_cwd',
    })}\n`

    const report = harvestReportFromNdjson(raw)
    expect(report.scope).toBe('shell')
    expect(report.availabilityQueue).toHaveLength(1)
    expect(report.candidates).toHaveLength(0)
  })
})
