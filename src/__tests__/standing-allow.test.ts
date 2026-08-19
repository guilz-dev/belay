import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  compactStandingAllow,
  loadStandingAllow,
  revokeStandingAllowEntry,
  type StandingAllowFile,
} from '../core/standing-allow.js'

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

  it('keeps legacy entries readable and revocable without granting runtime authority', () => {
    const active: StandingAllowFile = {
      version: 1,
      entries: [
        {
          kind: 'tool',
          fingerprint: 'tool-fp',
          source: 'operator',
          reason: 'legacy',
          createdAt: '2026-01-01T00:00:00.000Z',
          expiresAt: '2099-01-01T00:00:00.000Z',
        },
        {
          kind: 'subagent',
          fingerprint: 'subagent-fp',
          source: 'availability-reconfirmed',
          reason: 'legacy',
          createdAt: '2026-01-01T00:00:00.000Z',
          expiresAt: '2099-01-01T00:00:00.000Z',
        },
      ],
    }

    const revoked = revokeStandingAllowEntry(active, {
      kind: 'tool',
      fingerprint: 'tool-fp',
    })
    expect(revoked.removed).toBe(true)
    expect(revoked.state.entries).toEqual([active.entries[1]])
  })

  it('expires legacy entries during compaction', () => {
    const expired: StandingAllowFile = {
      version: 1,
      entries: [
        {
          kind: 'shell',
          fingerprint: 'expired-fp',
          source: 'operator',
          reason: 'legacy',
          createdAt: '2020-01-01T00:00:00.000Z',
          expiresAt: '2020-01-02T00:00:00.000Z',
        },
      ],
    }
    expect(compactStandingAllow(expired, Date.parse('2026-01-01T00:00:00.000Z')).entries).toEqual(
      [],
    )
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
