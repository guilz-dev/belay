import { readFile } from 'node:fs/promises'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { qualityCheck } from '../commands/quality.js'

describe('quality loop', () => {
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
    expect(report.ok).toBe(true)
  })
})
