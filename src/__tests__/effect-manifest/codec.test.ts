import { describe, expect, it } from 'vitest'

import {
  parseEffectManifestJsonV1,
  parseEffectManifestV1,
  ruleFingerprint,
} from '../../core/effect-manifest/codec.js'

const minimalManifest = {
  schemaVersion: 1,
  command: {
    basename: 'tool',
    canonicalPath: '/usr/bin/tool',
    sha256: 'b'.repeat(64),
    kind: 'native',
  },
  fallback: 'indeterminate',
  rules: [
    {
      id: 'r1',
      matcher: { argv: [{ kind: 'literal', value: 'run' }] },
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

describe('parseEffectManifestV1', () => {
  it('parses a minimal valid document', () => {
    const parsed = parseEffectManifestV1(minimalManifest)
    expect(parsed?.rules).toHaveLength(1)
    const rule = parsed?.rules[0]
    expect(rule).toBeDefined()
    if (!parsed || !rule) {
      throw new Error('expected parsed manifest rule')
    }
    expect(ruleFingerprint(parsed, rule)).toMatch(/^[a-f0-9]{64}$/)
  })

  it('rejects unknown top-level fields', () => {
    expect(parseEffectManifestV1({ ...minimalManifest, extra: true })).toBeNull()
  })

  it('rejects unknown nested fields and invalid typed matcher fields', () => {
    const rule = minimalManifest.rules[0]
    expect(
      parseEffectManifestV1({
        ...minimalManifest,
        rules: [{ ...rule, matcher: { argv: [{ kind: 'literal', value: 'run', extra: true }] } }],
      }),
    ).toBeNull()
    expect(
      parseEffectManifestV1({
        ...minimalManifest,
        rules: [
          {
            ...rule,
            matcher: { argv: [{ kind: 'integer', name: 'count', min: 10, max: 1 }] },
          },
        ],
      }),
    ).toBeNull()
  })

  it('preserves integer bounds and rejects non-NFC strings', () => {
    const rule = minimalManifest.rules[0]
    const parsed = parseEffectManifestV1({
      ...minimalManifest,
      rules: [
        {
          ...rule,
          matcher: { argv: [{ kind: 'integer', name: 'count', min: 1, max: 3 }] },
        },
      ],
    })
    expect(parsed?.rules[0]?.matcher.argv[0]).toEqual({
      kind: 'integer',
      name: 'count',
      min: 1,
      max: 3,
    })
    expect(
      parseEffectManifestV1({
        ...minimalManifest,
        rules: [{ ...rule, id: 'e\u0301' }],
      }),
    ).toBeNull()
  })

  it('rejects duplicate JSON object keys before parsing authority data', () => {
    const text = JSON.stringify(minimalManifest).replace(
      '"schemaVersion":1',
      '"schemaVersion":1,"schemaVersion":1',
    )
    expect(parseEffectManifestJsonV1(text)).toBeNull()
  })
})
