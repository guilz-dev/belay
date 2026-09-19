import { describe, expect, it } from 'vitest'

import { ruleFingerprint } from '../../core/effect-manifest/codec.js'
import { validateEffectManifestDocument } from '../../core/effect-manifest/validate.js'

const manifest = {
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

    const edited = {
      ...manifest,
      rules: [
        {
          ...rule,
          contract: { processOperation: 'inspect' as const, effects: [{ tag: 'read_only', action: 'read', resource: { kind: 'unknown' } }] },
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
})
