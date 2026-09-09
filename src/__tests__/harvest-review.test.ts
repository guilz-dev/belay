import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'
import { harvestApplyProject } from '../commands/harvest.js'
import { loadConfigFile } from '../config-io.js'
import { loadClassifierAuthorization } from '../core/capability/grant-loader.js'
import {
  buildShellCapabilityRequest,
  createTypeScriptPolicyEngine,
} from '../core/capability/policy-engine.js'
import {
  type HarvestReviewLedgerV1,
  latestHarvestReviews,
  loadHarvestReviewLedger,
  writeHarvestReviewLedgerAtomic,
} from '../core/harvest-review.js'
import { initProject } from '../installer.js'
import { resolveActiveAuditCohort } from '../runtime-provenance.js'

const tempDirs: string[] = []

function fingerprint(label: string): string {
  return createHash('sha256').update(label).digest('hex')
}

async function createFixture(params: { command: string; payloadFixture?: string }): Promise<{
  repoRoot: string
  corpusPath: string
  ledgerPath: string
  fingerprint: string
  boundaryProfile: string
}> {
  const repoRoot = await mkdtemp(path.join(os.tmpdir(), 'belay-harvest-review-'))
  tempDirs.push(repoRoot)
  await initProject({ targetDir: repoRoot })
  const config = await loadConfigFile(repoRoot)
  const cohort = await resolveActiveAuditCohort(repoRoot, config)
  if (!cohort) {
    throw new Error('fixture active cohort unavailable')
  }
  const commandFingerprint = fingerprint(params.command)
  const auditPath = path.resolve(repoRoot, config.audit.logPath)
  const records = [1, 2].map((index) => ({
    event: 'beforeShellExecution',
    kind: 'shell',
    verdict: 'deny_pending_approval',
    wouldBlock: true,
    fingerprint: commandFingerprint,
    summary: params.command,
    reason: 'unknown_local_effect',
    payload: params.payloadFixture,
    ...cohort,
    timestamp: `2026-09-07T00:00:0${index}.000Z`,
  }))
  await writeFile(auditPath, `${records.map((record) => JSON.stringify(record)).join('\n')}\n`)
  const corpusPath = path.join(repoRoot, 'shell-commands.json')
  await writeFile(corpusPath, '[]\n')
  return {
    repoRoot,
    corpusPath,
    ledgerPath: path.join(path.dirname(auditPath), 'harvest-reviews.json'),
    fingerprint: commandFingerprint,
    boundaryProfile: cohort.boundaryProfile,
  }
}

describe('harvest review ledger', () => {
  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
  })

  it('persists reject without storing the command or changing corpus', async () => {
    const command = 'node -e "console.log(process.env.SECRET_TOKEN)"'
    const payloadFixture = 'payload-secret-fixture-9a8704'
    const fixture = await createFixture({ command, payloadFixture })
    const corpusBefore = await readFile(fixture.corpusPath, 'utf8')

    const result = await harvestApplyProject({
      targetDir: fixture.repoRoot,
      corpusPath: fixture.corpusPath,
      command,
      outcome: 'reject',
      reason: 'opaque executable body',
    })

    expect(result.ok).toBe(true)
    expect(await readFile(fixture.corpusPath, 'utf8')).toBe(corpusBefore)
    const serialized = await readFile(fixture.ledgerPath, 'utf8')
    expect(serialized).not.toContain(command)
    expect(serialized).not.toContain(payloadFixture)
    expect(JSON.parse(serialized)).toMatchObject({
      version: 1,
      reviews: [
        {
          fingerprint: fixture.fingerprint,
          kind: 'shell',
          boundaryProfile: fixture.boundaryProfile,
          outcome: 'reject',
          reason: 'opaque executable body',
        },
      ],
    })
  })

  it('persists must-ask and appends a deny_pending_approval corpus case', async () => {
    const command = 'git push origin main'
    const fixture = await createFixture({ command })

    const result = await harvestApplyProject({
      targetDir: fixture.repoRoot,
      corpusPath: fixture.corpusPath,
      command,
      outcome: 'must-ask',
      reason: 'external mutation',
    })

    expect(result.ok).toBe(true)
    const ledger = await loadHarvestReviewLedger(fixture.ledgerPath)
    expect(ledger.reviews).toEqual([
      expect.objectContaining({
        fingerprint: fixture.fingerprint,
        boundaryProfile: fixture.boundaryProfile,
        outcome: 'must-ask',
      }),
    ])
    const corpus = JSON.parse(await readFile(fixture.corpusPath, 'utf8'))
    expect(corpus).toEqual([
      expect.objectContaining({
        kind: 'shell',
        category: 'must-ask',
        command,
        verdict: 'deny_pending_approval',
        provenance: {
          source: 'harvest',
          sourceBatchId: 'belay-2026-09-07',
          sourceCaseId: fixture.fingerprint,
          reviewedAt: ledger.reviews[0]?.reviewedAt,
        },
      }),
    ])
    expect(corpus[0].provenance).not.toHaveProperty('reviewedBy')
  })

  it('persists the selected historical boundary instead of the active boundary', async () => {
    const command = 'git diff --stat'
    const fixture = await createFixture({ command })
    const config = await loadConfigFile(fixture.repoRoot)
    const cohort = await resolveActiveAuditCohort(fixture.repoRoot, config)
    expect(cohort).not.toBeNull()
    if (!cohort) {
      throw new Error('fixture active cohort unavailable')
    }
    expect(cohort.boundaryProfile).toBe('l3-l4-only')
    const auditPath = path.resolve(fixture.repoRoot, config.audit.logPath)
    const records = ['l3-l4-only', 'l1-attested-boundary'].flatMap(
      (boundaryProfile, boundaryIndex) =>
        [1, 2].map((askIndex) => ({
          event: 'beforeShellExecution',
          kind: 'shell',
          verdict: 'deny_pending_approval',
          wouldBlock: true,
          fingerprint: fixture.fingerprint,
          summary: command,
          reason: 'unknown_local_effect',
          ...cohort,
          boundaryProfile,
          timestamp: `2026-09-07T00:0${boundaryIndex}:0${askIndex}.000Z`,
        })),
    )
    await writeFile(auditPath, `${records.map((record) => JSON.stringify(record)).join('\n')}\n`)

    const result = await harvestApplyProject({
      targetDir: fixture.repoRoot,
      corpusPath: fixture.corpusPath,
      command,
      outcome: 'reject',
      allCohorts: true,
      fingerprint: fixture.fingerprint,
      boundaryProfile: 'l1-attested-boundary',
    })

    expect(result.ok).toBe(true)
    expect(await loadHarvestReviewLedger(fixture.ledgerPath)).toMatchObject({
      version: 1,
      reviews: [
        {
          fingerprint: fixture.fingerprint,
          boundaryProfile: 'l1-attested-boundary',
          outcome: 'reject',
        },
      ],
    })
  })

  it('reviews a recorded all-cohort boundary when the active cohort is unavailable', async () => {
    const command = 'historical review without runtime'
    const fixture = await createFixture({ command })
    await rm(path.join(fixture.repoRoot, '.cursor', 'belay', 'runtime', 'core.mjs'))

    const result = await harvestApplyProject({
      targetDir: fixture.repoRoot,
      corpusPath: fixture.corpusPath,
      command,
      outcome: 'reject',
      allCohorts: true,
      boundaryProfile: fixture.boundaryProfile,
    })

    expect(result.ok).toBe(true)
    expect(await loadHarvestReviewLedger(fixture.ledgerPath)).toMatchObject({
      reviews: [
        {
          fingerprint: fixture.fingerprint,
          boundaryProfile: fixture.boundaryProfile,
          outcome: 'reject',
        },
      ],
    })
  })

  it('uses the latest review for the same fingerprint and boundary profile', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'belay-harvest-latest-'))
    tempDirs.push(dir)
    const ledgerPath = path.join(dir, 'harvest-reviews.json')
    const commandFingerprint = fingerprint('latest-review')
    const ledger: HarvestReviewLedgerV1 = {
      version: 1,
      reviews: [
        {
          fingerprint: commandFingerprint,
          kind: 'shell',
          boundaryProfile: 'l3-l4-only',
          outcome: 'accepted-benign',
          reviewedAt: '2026-09-07T00:00:00.000Z',
        },
        {
          fingerprint: commandFingerprint,
          kind: 'shell',
          boundaryProfile: 'l3-l4-only',
          outcome: 'reject',
          reviewedAt: '2026-09-07T00:01:00.000Z',
        },
      ],
    }

    await writeHarvestReviewLedgerAtomic(ledgerPath, ledger)

    const loaded = await loadHarvestReviewLedger(ledgerPath)
    expect(loaded.reviews).toHaveLength(1)
    expect([...latestHarvestReviews(loaded).values()]).toEqual([
      expect.objectContaining({ outcome: 'reject' }),
    ])
  })

  it('rejects malformed timestamps, fingerprints, boundary profiles, and outcomes', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'belay-harvest-invalid-'))
    tempDirs.push(dir)
    const ledgerPath = path.join(dir, 'harvest-reviews.json')
    const valid = {
      fingerprint: fingerprint('valid-review'),
      kind: 'shell',
      boundaryProfile: 'l3-l4-only',
      outcome: 'reject',
      reviewedAt: '2026-09-07T00:00:00.000Z',
    }
    const invalidRecords = [
      { ...valid, reviewedAt: 'yesterday' },
      { ...valid, fingerprint: 'not-a-fingerprint' },
      { ...valid, boundaryProfile: '' },
      { ...valid, boundaryProfile: 'future\nboundary' },
      { ...valid, boundaryProfile: '../authority' },
      { ...valid, boundaryProfile: 'x'.repeat(129) },
      { ...valid, outcome: 'allow' },
    ]

    for (const review of invalidRecords) {
      await writeFile(ledgerPath, `${JSON.stringify({ version: 1, reviews: [review] })}\n`)
      await expect(loadHarvestReviewLedger(ledgerPath)).rejects.toThrow(/harvest review/i)
    }
  })

  it('accepts a syntactically valid legacy or future boundary profile identity', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'belay-harvest-future-boundary-'))
    tempDirs.push(dir)
    const ledgerPath = path.join(dir, 'harvest-reviews.json')
    await writeFile(
      ledgerPath,
      `${JSON.stringify({
        version: 1,
        reviews: [
          {
            fingerprint: fingerprint('future-boundary-review'),
            kind: 'shell',
            boundaryProfile: 'future-contained-boundary-v2',
            outcome: 'reject',
            reviewedAt: '2026-09-07T00:00:00.000Z',
          },
        ],
      })}\n`,
    )

    expect(await loadHarvestReviewLedger(ledgerPath)).toMatchObject({
      reviews: [{ boundaryProfile: 'future-contained-boundary-v2' }],
    })
  })

  it('persists reject without reading a missing or malformed corpus', async () => {
    for (const corpusState of ['missing', 'malformed'] as const) {
      const command = `opaque reject ${corpusState}`
      const fixture = await createFixture({ command })
      if (corpusState === 'missing') {
        await rm(fixture.corpusPath)
      } else {
        await writeFile(fixture.corpusPath, '{ malformed corpus')
      }

      const result = await harvestApplyProject({
        targetDir: fixture.repoRoot,
        corpusPath: fixture.corpusPath,
        command,
        outcome: 'reject',
      })

      expect(result.ok).toBe(true)
      expect(await loadHarvestReviewLedger(fixture.ledgerPath)).toMatchObject({
        reviews: [{ fingerprint: fixture.fingerprint, outcome: 'reject' }],
      })
      if (corpusState === 'malformed') {
        expect(await readFile(fixture.corpusPath, 'utf8')).toBe('{ malformed corpus')
      }
    }
  })

  it('writes atomically and leaves the previous ledger readable on rename failure', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'belay-harvest-atomic-'))
    tempDirs.push(dir)
    const ledgerPath = path.join(dir, 'harvest-reviews.json')
    const commandFingerprint = fingerprint('atomic-review')
    const initialReview = {
      fingerprint: commandFingerprint,
      kind: 'shell' as const,
      boundaryProfile: 'l3-l4-only',
      outcome: 'reject' as const,
      reviewedAt: '2026-09-07T00:00:00.000Z',
    }
    const initial: HarvestReviewLedgerV1 = {
      version: 1,
      reviews: [initialReview],
    }
    await writeHarvestReviewLedgerAtomic(ledgerPath, initial)

    await expect(
      writeHarvestReviewLedgerAtomic(
        ledgerPath,
        {
          version: 1,
          reviews: [
            {
              ...initialReview,
              outcome: 'must-ask',
              reviewedAt: '2026-09-07T00:01:00.000Z',
            },
          ],
        },
        { rename: async () => Promise.reject(new Error('injected rename failure')) },
      ),
    ).rejects.toThrow('injected rename failure')

    expect(await loadHarvestReviewLedger(ledgerPath)).toEqual(initial)
    expect((await stat(ledgerPath)).mode & 0o777).toBe(0o600)
    await expect((await import('node:fs/promises')).readdir(dir)).resolves.toEqual([
      'harvest-reviews.json',
    ])
  })

  it('does not expose reviews to PolicyEngine or grant loading', async () => {
    const fixture = await createFixture({ command: 'git push origin main' })
    await writeHarvestReviewLedgerAtomic(fixture.ledgerPath, {
      version: 1,
      reviews: [
        {
          fingerprint: fixture.fingerprint,
          kind: 'shell',
          boundaryProfile: fixture.boundaryProfile,
          outcome: 'provably-benign',
          reviewedAt: '2026-09-07T00:00:00.000Z',
        },
      ],
    })
    const config = await loadConfigFile(fixture.repoRoot)
    const authorization = await loadClassifierAuthorization({
      repoRoot: fixture.repoRoot,
      config,
      approvedState: { version: 1, approvals: [] },
    })
    const request = buildShellCapabilityRequest({
      command: 'git push origin main',
      hookKind: 'shell',
      segmentHead: 'git',
      effect: 'remote_mutation',
      location: 'external',
      opacity: 'transparent',
      pathArgs: [],
      signals: ['external_effect'],
      cwd: fixture.repoRoot,
      repoRoot: fixture.repoRoot,
      inputFingerprint: fixture.fingerprint,
    })

    expect(authorization.grants).toBeUndefined()
    expect(
      createTypeScriptPolicyEngine().evaluate(request, { config, ...authorization }).outcome,
    ).toBe('require_approval')
  })
})
