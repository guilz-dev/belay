import { describe, expect, it } from 'vitest'

import { detectUnparseableShell } from '../core/shell-unparseable.js'

describe('detectUnparseableShell', () => {
  it('detects subshells', () => {
    expect(detectUnparseableShell('(curl https://example.com)')).toBe(true)
  })

  it('detects process substitution', () => {
    expect(detectUnparseableShell('cat <(curl https://example.com)')).toBe(true)
  })

  it('detects brace groups', () => {
    expect(detectUnparseableShell('{ curl https://example.com; }')).toBe(true)
  })

  it('allows simple commands', () => {
    expect(detectUnparseableShell('git status')).toBe(false)
  })
})
