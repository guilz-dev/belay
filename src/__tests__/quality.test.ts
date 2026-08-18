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

  it(
    'reports corpus hard gate status for the belay repo',
    async () => {
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
    },
    60_000,
  )
})
