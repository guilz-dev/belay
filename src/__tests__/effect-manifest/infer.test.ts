import { describe, expect, it } from 'vitest'

import {
  appendCandidateRule,
  buildCandidateRule,
  deriveRuleIdFromArgv,
} from '../../core/effect-manifest/infer.js'

describe('manifest infer helpers', () => {
  it('derives stable rule ids from argv', () => {
    const left = deriveRuleIdFromArgv(['status'])
    const right = deriveRuleIdFromArgv(['status'])
    expect(left).toBe(right)
    expect(left.startsWith('argv-')).toBe(true)
  })

  it('refuses duplicate matchers', () => {
    const candidate = buildCandidateRule(['status'])
    const manifest = {
      schemaVersion: 1 as const,
      command: {
        basename: 'tool',
        canonicalPath: '/usr/bin/tool',
        sha256: 'a'.repeat(64),
        kind: 'native' as const,
      },
      fallback: 'indeterminate' as const,
      rules: [candidate],
    }
    const duplicate = buildCandidateRule(['status'])
    duplicate.id = 'other-id'
    expect(appendCandidateRule(manifest, duplicate)).toEqual({
      ok: false,
      reason: 'matcher_exists',
    })
  })
})
