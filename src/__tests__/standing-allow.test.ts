import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  addStandingAllowEntry,
  compactStandingAllow,
  isTier0StandingAllowBlocked,
  loadStandingAllow,
  resolveStandingAllowMatch,
  revokeStandingAllowEntry,
  type StandingAllowFile,
} from '../core/standing-allow.js'
import type { ClassifyResult } from '../core/types.js'

function denyResult(overrides: Partial<ClassifyResult> = {}): ClassifyResult {
  return {
    verdict: 'deny_pending_approval',
    reason: 'unknown_local_effect',
    summary: 'git status',
    normalizedCommand: 'git status',
    fingerprint: 'test-fingerprint',
    assessment: {
      reversibility: 'reversible',
      external: false,
      blastRadius: 'none',
      confidence: 0.5,
      signals: ['unknown_local_effect'],
    },
    ...overrides,
  }
}

describe('standing-allow', () => {
  const tempDirs: string[] = []

  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
  })

  it('has no catalog-only source or emitted audit field', async () => {
    const repoRoot = path.resolve(import.meta.dirname, '../..')
    const [standingSource, gateRuntimeSource] = await Promise.all([
      readFile(path.join(repoRoot, 'src/core/standing-allow.ts'), 'utf8'),
      readFile(path.join(repoRoot, 'src/adapters/shared/gate-runtime.ts'), 'utf8'),
    ])

    expect(standingSource).not.toContain("'provably-benign-corpus'")
    expect(standingSource).not.toContain("'must-allow-catalog'")
    expect(standingSource).not.toContain('catalogCommand')
    expect(gateRuntimeSource).not.toContain('standingAllowCatalogCommand')
  })

  it('does not let a shell standing entry override a partial EffectPlan ask', () => {
    const state = addStandingAllowEntry(
      { version: 1, entries: [] },
      {
        kind: 'shell',
        fingerprint: 'partial-plan-fp',
        source: 'operator',
        reason: 'legacy shell standing allow',
        expiresAt: '2099-01-01T00:00:00.000Z',
      },
    )
    const match = resolveStandingAllowMatch({
      kind: 'shell',
      result: denyResult({
        normalizedCommand: 'git status',
        summary: 'git status',
        fingerprint: 'partial-plan-fp',
      }),
      repoRoot: '/tmp/repo',
      state,
    })

    expect(match).toBeNull()
  })

  it('does not match when verdict is already allow', () => {
    const match = resolveStandingAllowMatch({
      kind: 'shell',
      result: {
        ...denyResult(),
        verdict: 'allow',
        reason: 'read_only',
      },
      repoRoot: '/tmp/repo',
      state: { version: 1, entries: [] },
    })
    expect(match).toBeNull()
  })

  it('blocks Tier0 must-ask paths even when catalog command overlaps', () => {
    const match = resolveStandingAllowMatch({
      kind: 'shell',
      result: denyResult({
        normalizedCommand: 'git push origin main',
        summary: 'git push origin main',
        reason: 'external_effect',
        assessment: {
          reversibility: 'irreversible',
          external: true,
          blastRadius: 'remote',
          confidence: 1,
          signals: ['tier0_external'],
        },
      }),
      repoRoot: '/tmp/repo',
      state: { version: 1, entries: [] },
    })
    expect(match).toBeNull()
    expect(
      isTier0StandingAllowBlocked(
        denyResult({
          reason: 'external_effect',
          assessment: {
            reversibility: 'irreversible',
            external: true,
            blastRadius: 'remote',
            confidence: 1,
            signals: ['tier0_external'],
          },
        }),
      ),
    ).toBe(true)
  })

  it('blocks catastrophic reasons without relying on assessment signals', () => {
    for (const reason of [
      'tier1_catastrophic',
      'protected_artifact',
      'pipe_to_shell',
      'command_substitution',
    ] as const) {
      expect(
        isTier0StandingAllowBlocked(
          denyResult({
            reason,
            assessment: {
              reversibility: 'reversible',
              external: false,
              blastRadius: 'none',
              confidence: 0.5,
              signals: [],
            },
          }),
        ),
        reason,
      ).toBe(true)
      expect(
        resolveStandingAllowMatch({
          kind: 'shell',
          result: denyResult({
            reason,
            normalizedCommand: 'git status',
            assessment: {
              reversibility: 'reversible',
              external: false,
              blastRadius: 'none',
              confidence: 0.5,
              signals: [],
            },
          }),
          repoRoot: '/tmp/repo',
          state: addStandingAllowEntry(
            { version: 1, entries: [] },
            {
              kind: 'shell',
              fingerprint: 'operator-fp',
              source: 'operator',
              reason: 'test',
              expiresAt: '2099-01-01T00:00:00.000Z',
            },
          ),
        }),
        reason,
      ).toBeNull()
    }
  })

  it('preserves non-shell operator state entries by fingerprint with TTL', () => {
    const state = addStandingAllowEntry(
      { version: 1, entries: [] },
      {
        kind: 'tool',
        fingerprint: 'operator-fp',
        source: 'availability-reconfirmed',
        reason: 'judge_fallback',
        repoRoot: '/tmp/repo',
        ttlMs: 60_000,
      },
    )
    const match = resolveStandingAllowMatch({
      kind: 'tool',
      result: denyResult({
        normalizedCommand: 'gh pr list',
        fingerprint: 'operator-fp',
      }),
      repoRoot: '/tmp/repo',
      state,
    })
    expect(match?.source).toBe('availability-reconfirmed')
  })

  it('expires operator entries and supports revoke', () => {
    const created = addStandingAllowEntry(
      { version: 1, entries: [] },
      {
        kind: 'shell',
        fingerprint: 'expired-fp',
        source: 'operator',
        reason: 'test',
        createdAt: '2020-01-01T00:00:00.000Z',
        expiresAt: '2020-01-02T00:00:00.000Z',
      },
    )
    expect(compactStandingAllow(created, Date.parse('2026-01-01T00:00:00.000Z')).entries).toEqual(
      [],
    )

    const active = addStandingAllowEntry(
      { version: 1, entries: [] },
      {
        kind: 'shell',
        fingerprint: 'active-fp',
        source: 'operator',
        reason: 'test',
        expiresAt: '2099-01-01T00:00:00.000Z',
      },
    )
    const revoked = revokeStandingAllowEntry(active, {
      kind: 'shell',
      fingerprint: 'active-fp',
    })
    expect(revoked.removed).toBe(true)
    expect(revoked.state.entries).toEqual([])
  })

  it('does not treat one-off approvals as standing-allow state', () => {
    const state: StandingAllowFile = { version: 1, entries: [] }
    const match = resolveStandingAllowMatch({
      kind: 'shell',
      result: denyResult({
        normalizedCommand: 'make deploy',
        fingerprint: 'approved-once-only',
      }),
      repoRoot: '/tmp/repo',
      state,
    })
    expect(match).toBeNull()
  })

  it('drops invalid state sources and prunes expired entries on load', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'belay-standing-allow-load-'))
    tempDirs.push(dir)
    const filePath = path.join(dir, 'standing-allow.json')
    await writeFile(
      filePath,
      `${JSON.stringify(
        {
          version: 1,
          entries: [
            {
              kind: 'shell',
              fingerprint: 'expired',
              source: 'operator',
              reason: 'test',
              createdAt: '2020-01-01T00:00:00.000Z',
              expiresAt: '2020-01-02T00:00:00.000Z',
            },
            {
              kind: 'shell',
              fingerprint: 'catalog-forged',
              source: 'provably-benign-corpus',
              reason: 'forged',
              createdAt: '2026-01-01T00:00:00.000Z',
              expiresAt: '2099-01-01T00:00:00.000Z',
            },
          ],
        },
        null,
        2,
      )}\n`,
      'utf8',
    )

    const loaded = await loadStandingAllow(filePath)
    expect(loaded.entries).toEqual([])
    const persisted = JSON.parse(await readFile(filePath, 'utf8')) as { entries: unknown[] }
    expect(persisted.entries).toEqual([])
  })
})
