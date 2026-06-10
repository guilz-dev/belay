import { describe, expect, it } from 'vitest'

import { matchesCustomCommand } from '../core/custom-command-match.js'

describe('matchesCustomCommand', () => {
  it('matches exact normalized commands and keys only', () => {
    expect(
      matchesCustomCommand('pnpm release:staging', 'pnpm release:staging', 'pnpm release:staging'),
    ).toBe(true)
    expect(matchesCustomCommand('git push origin main', 'git push', 'git')).toBe(false)
  })
})
