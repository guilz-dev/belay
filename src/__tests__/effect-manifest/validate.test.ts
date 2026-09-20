import { describe, expect, it } from 'vitest'

import { ruleFingerprint } from '../../core/effect-manifest/codec.js'
import type { EffectManifestV1 } from '../../core/effect-manifest/types.js'
import { validateEffectManifestDocument } from '../../core/effect-manifest/validate.js'

const manifest: EffectManifestV1 = {
  schemaVersion: 1,
  command: {
    basename: 'tool',
    canonicalPath: '/usr/bin/tool',
    sha256: 'a'.repeat(64),
    kind: 'native',
  },
  fallback: 'indeterminate',
  rules: [
    {
      id: 'r1',
      matcher: { argv: [{ kind: 'literal', value: 'status' }] },
      contract: { processOperation: 'inspect', effects: [] },
      assertion: 'complete-upper-bound',
      inference: {
        method: 'manual',
        generatedAt: '2026-09-19T00:00:00.000Z',
        generatorVersion: 'test',
        evidence: [],
        warnings: [],
      },
    },
  ],
}

describe('validateEffectManifestDocument', () => {
  it('keeps stale trusted rules eligible for re-trust', () => {
    const rule = manifest.rules[0]
    if (!rule) {
      throw new Error('rule missing')
    }
    const report = validateEffectManifestDocument(manifest, '/repo')
    expect(report.trustEligibleRuleIds).toContain('r1')

    const edited: EffectManifestV1 = {
      ...manifest,
      rules: [
        {
          ...rule,
          contract: {
            processOperation: 'inspect',
            effects: [
              { tag: 'fs.read', action: 'fs.read', resource: { kind: 'path', path: '/tmp/other' } },
            ],
          },
        },
      ],
    }
    const editedRule = edited.rules[0]
    if (!editedRule) {
      throw new Error('edited rule missing')
    }
    const fingerprint = ruleFingerprint(edited, editedRule)
    const staleReport = validateEffectManifestDocument(edited, '/repo')
    expect(staleReport.trustEligibleRuleIds).toContain('r1')
    expect(fingerprint).not.toBe(ruleFingerprint(manifest, rule))
  })

  it('rejects overlapping matcher languages, not just identical syntax', () => {
    const rule = manifest.rules[0]
    if (!rule) {
      throw new Error('rule missing')
    }
    const report = validateEffectManifestDocument(
      {
        ...manifest,
        rules: [
          rule,
          {
            ...rule,
            id: 'r2',
            matcher: { argv: [{ kind: 'enum', name: 'command', values: ['status', 'show'] }] },
            contract: {
              processOperation: 'inspect',
              effects: [
                {
                  tag: 'process.exec',
                  action: 'process.exec',
                  resource: {
                    kind: 'executable',
                    command: `\${command}`,
                    operation: 'inspect',
                  },
                },
              ],
            },
          },
        ],
      },
      '/repo',
    )
    expect(report.ok).toBe(false)
    expect(report.issues.some((issue) => issue.code === 'matcher_overlap')).toBe(true)
    expect(report.trustEligibleRuleIds).toEqual([])
  })

  it('rejects unused captures and broad leading token captures', () => {
    const rule = manifest.rules[0]
    if (!rule) {
      throw new Error('rule missing')
    }
    const unused = validateEffectManifestDocument(
      {
        ...manifest,
        rules: [{ ...rule, matcher: { argv: [{ kind: 'path', name: 'target' }] } }],
      },
      '/repo',
    )
    expect(unused.issues.some((issue) => issue.code === 'unused_capture')).toBe(true)

    const broad = validateEffectManifestDocument(
      {
        ...manifest,
        rules: [
          {
            ...rule,
            matcher: { argv: [{ kind: 'token', name: 'anything' }] },
            contract: {
              processOperation: 'inspect',
              effects: [
                {
                  tag: 'process.exec',
                  action: 'process.exec',
                  resource: {
                    kind: 'executable',
                    command: `\${anything}`,
                    operation: 'inspect',
                  },
                },
              ],
            },
          },
        ],
      },
      '/repo',
    )
    expect(broad.issues.some((issue) => issue.code === 'broad_token_capture')).toBe(true)
  })
})
