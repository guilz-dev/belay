import { createHash } from 'node:crypto'
import { mkdtemp, rm, unlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { harvestListProject, harvestReportFromNdjson } from '../commands/harvest.js'
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
} from '../core/harvest.js'
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

    const oldCohort = {
      ...cohort!,
      runtimeArtifactHash: testFingerprint('old-runtime-artifact'),
    }
    const currentCohort = cohort!
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
    expect(currentReport.excludedGateEvents).toBe(2)
    expect(allReport.candidates.map((entry) => entry.command)).toEqual([
      'current command',
      'old command',
    ])
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
