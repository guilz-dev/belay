import { describe, expect, it } from 'vitest'

import { qualityCheck } from '../commands/quality.js'
import { toAuditRecord } from '../core/audit-query.js'
import { extractHarvestCandidates } from '../core/harvest.js'

describe('quality loop', () => {
  it('flags overrides.allow matches as harvest candidates', () => {
    const records = [
      toAuditRecord({
        event: 'beforeShellExecution',
        kind: 'shell',
        verdict: 'deny_pending_approval',
        wouldBlock: true,
        fingerprint: 'fp-override',
        summary: 'pnpm release:staging',
        reason: 'unknown_local_effect',
      }),
    ]

    const candidates = extractHarvestCandidates(records, {
      allowPatterns: ['pnpm release:staging'],
    })
    expect(candidates[0]?.sources).toContain('overrides_allow')
  })

  it('reports corpus hard gate status for the belay repo', async () => {
    const report = await qualityCheck({ targetDir: process.cwd() })
    expect(report.schemaVersion).toBe(1)
    expect(report.corpus.passesHardGates).toBe(true)
    expect(report.corpus.mustAskMisses).toBe(0)
    expect(report.corpus.provablyBenignBlocks).toBe(0)
    expect(report.harvest.scope).toBe('shell')
    expect(report.notes.some((note) => note.includes('hard gates'))).toBe(true)
    expect(report.ok).toBe(true)
  })
})
